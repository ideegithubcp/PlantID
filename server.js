require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const tracker = require('./spend_tracker');

// Ensure uploads dir exists (Render filesystem starts empty)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static('public'));

// --- Spend status endpoint (used by frontend) ---
app.get('/api/spend', (req, res) => res.json(tracker.getStatus()));

// --- Admin: approve more Claude spend ---
app.post('/api/spend/approve', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.body.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(tracker.approve());
});

// --- PlantNet + Gemini (free default, falls back to Claude) ---
app.post('/api/identify', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided' });

  try {
    const plantNetResult = await identifyWithPlantNet(files);
    let result;
    try {
      result = await analyzeWithGemini(files, plantNetResult);
    } catch (geminiErr) {
      console.warn('Gemini unavailable, falling back to Claude:', geminiErr.message);
      if (tracker.isLocked()) {
        cleanup(files);
        return res.status(402).json({
          error: 'claude_locked',
          message: `Claude spend limit of $${tracker.SPEND_LIMIT} reached. Approve more spend to continue.`,
          spend: tracker.getStatus()
        });
      }
      result = await identifyWithClaude(files, plantNetResult);
    }
    cleanup(files);
    res.json(result);
  } catch (err) {
    cleanup(files);
    console.error('Identify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Claude explicit mode ---
app.post('/api/identify/claude', upload.array('images', 5), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: 'No images provided' });

  if (tracker.isLocked()) {
    cleanup(files);
    return res.status(402).json({
      error: 'claude_locked',
      message: `Claude spend limit of $${tracker.SPEND_LIMIT} reached. Approve more spend to continue.`,
      spend: tracker.getStatus()
    });
  }

  try {
    const result = await identifyWithClaude(files, null);
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
    const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
    const filename = (file.originalname || 'plant') + (file.originalname?.includes('.') ? '' : ext);
    form.append('images', fs.createReadStream(file.path), filename);
  }

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
2. If confident (>70%), provide all fields below.
3. If NOT confident, explain what's unclear and ask for specific better photos. Do NOT guess.

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
  "seasonal": "Brief description of how this plant looks across the four seasons (spring/summer/autumn/winter).",
  "lookalikes": [{ "name": "...", "warning": "How to tell them apart and why it matters" }],
  "needsBetterPhoto": false,
  "photoRequest": null
}

For lookalikes, include any plants that could be confused with this one, especially if any are toxic. Return empty array if none.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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

  return parseJSON(text);
}

async function identifyWithClaude(files, plantNetResult) {
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

  let plantContext = '';
  if (plantNetResult && plantNetResult.results && plantNetResult.results.length > 0) {
    const top = plantNetResult.results.slice(0, 3);
    plantContext = `PlantNet identified these candidates:\n` +
      top.map((r, i) => {
        const score = Math.round(r.score * 100);
        const common = r.species.commonNames?.[0] || 'unknown';
        return `${i + 1}. ${r.species.scientificNameWithoutAuthor} (${common}) — ${score}%`;
      }).join('\n') + '\n\n';
  }

  const prompt = `You are an expert botanist. Identify the plant in these ${files.length} photo(s).\n\n${plantContext}If confident, provide all fields. If NOT confident, ask for specific better photos.

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
  "seasonal": "Brief description of how this plant looks across the four seasons.",
  "lookalikes": [{ "name": "...", "warning": "How to tell them apart and why it matters" }],
  "needsBetterPhoto": false,
  "photoRequest": null
}

For lookalikes include plants that could be confused with this one, especially toxic ones. Return empty array if none.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: prompt }] }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Claude');

  // Record spend from usage stats
  if (data.usage) {
    tracker.recordUsage(data.usage.input_tokens, data.usage.output_tokens);
  }

  return parseJSON(text);
}

function parseJSON(text) {
  // Extract first JSON object from text
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  let raw = match[0];
  try {
    return JSON.parse(raw);
  } catch {
    // Remove trailing commas before ] or }
    raw = raw.replace(/,(\s*[}\]])/g, '$1');
    // Replace unescaped newlines inside strings
    raw = raw.replace(/"((?:[^"\\]|\\.)*)"/g, (_, s) => '"' + s.replace(/\n/g, ' ').replace(/\r/g, '') + '"');
    return JSON.parse(raw);
  }
}

function cleanup(files) {
  for (const file of files) {
    fs.unlink(file.path, () => {});
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const status = tracker.getStatus();
  console.log(`PlantID running at http://localhost:${PORT}`);
  console.log(`Claude spend: $${status.totalSpend.toFixed(4)} / $${status.limit} (${status.percentUsed}% used)${status.locked ? ' — LOCKED' : ''}`);
});
