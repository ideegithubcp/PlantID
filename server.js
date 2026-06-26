require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static('public'));

// --- PlantNet + Gemini (free default) ---
app.post('/api/identify', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided' });

  try {
    const plantNetResult = await identifyWithPlantNet(files);
    const geminiAnalysis = await analyzeWithGemini(files, plantNetResult);
    cleanup(files);
    res.json(geminiAnalysis);
  } catch (err) {
    cleanup(files);
    console.error('Free identify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Claude ---
app.post('/api/identify/claude', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided' });

  try {
    const result = await identifyWithClaude(files);
    cleanup(files);
    res.json(result);
  } catch (err) {
    cleanup(files);
    console.error('Claude identify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function identifyWithPlantNet(files) {
  const apiKey = process.env.PLANTNET_API_KEY;
  if (!apiKey) throw new Error('PLANTNET_API_KEY not configured');

  const form = new FormData();
  for (const file of files) {
    form.append('images', fs.createReadStream(file.path), file.originalname || 'plant.jpg');
  }
  form.append('include-related-images', 'false');

  const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${apiKey}&lang=en&nb-results=3`;
  const response = await fetch(url, { method: 'POST', body: form });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PlantNet error: ${response.status} — ${err}`);
  }

  return response.json();
}

async function analyzeWithGemini(files, plantNetResult) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // Build context from PlantNet results
  let plantContext = '';
  if (plantNetResult && plantNetResult.results && plantNetResult.results.length > 0) {
    const top = plantNetResult.results.slice(0, 3);
    plantContext = `PlantNet identified these candidates (in order of confidence):\n` +
      top.map((r, i) => {
        const score = Math.round(r.score * 100);
        const common = r.species.commonNames?.[0] || 'unknown common name';
        return `${i + 1}. ${r.species.scientificNameWithoutAuthor} (${common}) — ${score}% confidence`;
      }).join('\n');
  } else {
    plantContext = 'PlantNet could not identify the plant.';
  }

  // Encode images as base64 for Gemini
  const imageParts = files.map(file => ({
    inline_data: {
      mime_type: file.mimetype,
      data: fs.readFileSync(file.path).toString('base64')
    }
  }));

  const prompt = `You are a plant identification expert. The user has uploaded ${files.length} photo(s) of a plant.

${plantContext}

Based on the photos and PlantNet's analysis, please:
1. Confirm or correct the identification with your own visual assessment.
2. If confident (>70%), provide:
   - Common name and scientific name
   - Brief description (2-3 sentences)
   - Care tips (watering, light, soil)
   - Any toxicity or safety warnings
   - Interesting facts
3. If NOT confident, explain what's unclear and ask for specific better photos (e.g., "Please photograph the leaf underside", "A close-up of the flower would help"). Do NOT guess.

Respond in JSON format:
{
  "identified": true/false,
  "commonName": "...",
  "scientificName": "...",
  "confidence": "high/medium/low",
  "description": "...",
  "care": { "water": "...", "light": "...", "soil": "..." },
  "toxicity": "...",
  "facts": ["...", "..."],
  "needsBetterPhoto": false,
  "photoRequest": null
}

If not identified, set identified=false, needsBetterPhoto=true, and photoRequest to a clear instruction string.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [...imageParts, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text);
}

async function identifyWithClaude(files) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const imageContent = files.map(file => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: file.mimetype,
      data: fs.readFileSync(file.path).toString('base64')
    }
  }));

  const prompt = `You are an expert botanist. Identify the plant in these ${files.length} photo(s).

If confident, provide:
- Common name and scientific name
- Brief description
- Care tips (watering, light, soil)
- Toxicity/safety notes
- 2-3 interesting facts

If NOT confident, explain what's unclear and ask for specific better photos.

Respond in this exact JSON format:
{
  "identified": true/false,
  "commonName": "...",
  "scientificName": "...",
  "confidence": "high/medium/low",
  "description": "...",
  "care": { "water": "...", "light": "...", "soil": "..." },
  "toxicity": "...",
  "facts": ["...", "..."],
  "needsBetterPhoto": false,
  "photoRequest": null
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Claude');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse Claude response');
  return JSON.parse(jsonMatch[0]);
}

function cleanup(files) {
  for (const file of files) {
    fs.unlink(file.path, () => {});
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PlantID running at http://localhost:${PORT}`));
