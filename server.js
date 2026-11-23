import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/.env',
  '/.env.example',
]);

app.use(express.json({ limit: '64kb' }));

function getGeminiClient() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sanitizeCatalog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map((u) => ({
    ref: typeof u?.ref === 'string' ? u.ref.slice(0, 12) : '',
    portal: typeof u?.portal === 'string' ? u.portal.slice(0, 20) : '',
    pl: typeof u?.pl === 'string' || typeof u?.pl === 'number' ? String(u.pl).slice(0, 16) : '',
    h: Number.isFinite(Number(u?.h)) ? Number(u.h) : 0,
    m2: Number.isFinite(Number(u?.m2)) ? Number(u.m2) : 0,
    r: Number.isFinite(Number(u?.r)) ? Number(u.r) : 0,
    st: ['D', 'R', 'A'].includes(u?.st) ? u.st : 'D',
    t: Boolean(u?.t),
    g: Boolean(u?.g),
    tr: Boolean(u?.tr),
  })).filter((u) => /^REF-\d{2,3}$/.test(u.ref) && u.r > 0);
}

const CALC_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Título breve del cálculo o respuesta en español' },
    explanation: { type: Type.STRING, description: 'Respuesta clara, útil y concisa en español (máximo 3 frases)' },
    rows: {
      type: Type.ARRAY,
      description: 'Filas clave del cálculo financiero (máximo 6 filas)',
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          value: { type: Type.STRING },
          highlight: { type: Type.BOOLEAN },
        },
        required: ['label', 'value'],
      },
    },
    statusLevel: { type: Type.STRING, description: 'ok, warn, bad o none' },
    statusText: { type: Type.STRING, description: 'Veredicto breve de solvencia si aplica, o cadena vacía' },
    recommendedRefs: {
      type: Type.ARRAY,
      description: 'Hasta 3 códigos REF-XX únicamente de viviendas con st=D del catálogo recibido',
      items: { type: Type.STRING },
    },
    handoff: { type: Type.STRING, description: 'Resumen breve en primera persona para enviar al equipo por correo' },
  },
  required: ['title', 'explanation', 'rows'],
};

app.post('/api/calc-ai', async (req, res) => {
  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'El asistente con IA requiere configurar GEMINI_API_KEY en Settings > Secrets.',
      code: 'MISSING_API_KEY',
    });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > 600) {
    return res.status(400).json({ error: 'Escribe una pregunta o cálculo de hasta 600 caracteres.' });
  }

  const catalog = sanitizeCatalog(req.body?.catalog);
  const activeRef = typeof req.body?.activeRef === 'string' && /^REF-\d{2,3}$/.test(req.body.activeRef)
    ? req.body.activeRef
    : '';
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .slice(-6)
        .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string')
        .map((h) => `${h.role === 'user' ? 'Usuario' : 'Asistente'}: ${h.text.slice(0, 320)}`)
    : [];

  const availableUnits = catalog.filter((u) => u.st === 'D').sort((a, b) => a.r - b.r);
  const catalogLines = catalog.length
    ? catalog.map((u) => `${u.ref}|${u.st}|${u.portal}|P${u.pl}|${u.h}hab|${u.m2}m2|${u.r}€/mes|gar:${u.g ? 'si' : 'no'}|ter:${u.t ? 'si' : 'no'}`).join('\n')
    : 'Sin catálogo proporcionado';

  const systemInstruction = [
    'Eres la calculadora inmobiliaria con IA de INVERCOR PATRIMONIO S.L. para la promoción de 45 viviendas de obra nueva en alquiler en Móstoles (Madrid).',
    'Reglas financieras oficiales de la promoción:',
    '- Criterio de solvencia directa (ratio 3x): la renta mensual no debe superar el 33,33% de los ingresos netos mensuales totales (renta máxima = Math.floor(ingresos / 3)).',
    '- Tramo ajustado con aval o segundo titular: hasta el 40% de los ingresos netos mensuales.',
    '- Costes estimados a la firma (entrada): 1.ª mensualidad + 1 mes de fianza legal (AVS Comunidad de Madrid) + 1 mes de garantía adicional = 3 mensualidades en total.',
    '- Si el usuario pregunta por ahorro, gastos mensuales (luz/agua/internet orientativos), dividir alquiler entre varias personas, comparar pisos concretos (REF-XX), ingresos anuales vs mensuales (12 o 14 pagas) o cualquier cálculo aritmético, haz las cuentas con precisión exacta.',
    '- Usa formato numérico español (ej. 1.150 €/mes, 3.300 €).',
    '- Solo incluye en recommendedRefs referencias REF-XX reales con st=D (disponibles) del catálogo proporcionado.',
    '- Sé conciso, práctico y directo (máximo 3 frases en explanation y hasta 6 filas en rows).',
  ].join('\n');

  const promptParts = [
    `Catálogo actual de viviendas (st: D=Disponible, R=Reservada, A=Alquilada; total disponibles: ${availableUnits.length}):`,
    catalogLines,
    activeRef ? `Vivienda que está viendo ahora el usuario: ${activeRef}` : '',
    history.length ? `Contexto reciente:\n${history.join('\n')}` : '',
    `Consulta actual del usuario: ${message}`,
  ].filter(Boolean).join('\n\n');

  try {
    const attempts = [
      { model: 'gemini-4-hydrogen', delayMs: 0 },
      { model: 'gemini-3.1-flash-lite', delayMs: 350 },
      { model: 'gemini-4-hydrogen', delayMs: 900 },
    ];
    let response;
    let lastErr;
    for (const step of attempts) {
      if (step.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      }
      try {
        response = await ai.models.generateContent({
          model: step.model,
          contents: promptParts,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: CALC_RESPONSE_SCHEMA,
          },
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const s = Number(e?.status || e?.code) || 0;
        const m = String(e?.message || '');
        if (s === 503 || s === 429 || m.includes('UNAVAILABLE') || m.includes('RESOURCE_EXHAUSTED')) {
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      return res.status(502).json({ error: 'La IA no devolvió respuesta. Inténtalo de nuevo.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'No se pudo interpretar la respuesta de la IA.' });
    }

    const validAvailRefs = new Set(availableUnits.map((u) => u.ref));
    const safeRefs = Array.isArray(parsed.recommendedRefs)
      ? parsed.recommendedRefs.filter((r) => typeof r === 'string' && validAvailRefs.has(r)).slice(0, 3)
      : [];

    return res.json({
      ok: true,
      result: {
        title: typeof parsed.title === 'string' ? parsed.title.slice(0, 120) : 'Cálculo con IA',
        text: typeof parsed.explanation === 'string' ? parsed.explanation.slice(0, 800) : '',
        rows: Array.isArray(parsed.rows)
          ? parsed.rows
              .slice(0, 6)
              .filter((r) => r && typeof r.label === 'string' && typeof r.value === 'string')
              .map((r) => ({
                label: r.label.slice(0, 90),
                value: r.value.slice(0, 90),
                em: Boolean(r.highlight),
              }))
          : [],
        status: ['ok', 'warn', 'bad'].includes(parsed.statusLevel) && typeof parsed.statusText === 'string' && parsed.statusText.trim()
          ? { cls: parsed.statusLevel, text: parsed.statusText.trim().slice(0, 200) }
          : null,
        recommendedRefs: safeRefs,
        handoff: typeof parsed.handoff === 'string' ? parsed.handoff.slice(0, 300) : '',
      },
    });
  } catch (err) {
    const status = Number(err?.status || err?.code) || 500;
    const msg = String(err?.message || '');
    console.error('Gemini calc-ai error:', status, msg);

    if (status === 400 || status === 403 || msg.includes('API_KEY') || msg.includes('PERMISSION_DENIED')) {
      return res.status(status === 403 ? 403 : 400).json({
        error: 'Verifica tu clave GEMINI_API_KEY en Settings > Secrets.',
        code: 'API_KEY_ERROR',
      });
    }
    if (status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        error: 'Se ha superado temporalmente el límite de consultas de IA. Inténtalo en unos segundos.',
        code: 'RATE_LIMIT',
      });
    }
    if (status === 503 || msg.includes('UNAVAILABLE')) {
      return res.status(503).json({
        error: 'El servicio de IA está recibiendo alta demanda en este momento. Inténtalo de nuevo en unos segundos.',
        code: 'HIGH_DEMAND',
      });
    }
    return res.status(502).json({
      error: 'No se pudo conectar con la IA en este momento. Inténtalo de nuevo.',
      code: 'UPSTREAM_ERROR',
    });
  }
});

app.use((req, res, next) => {
  const normalizedPath = path.posix.normalize(req.path);
  if (
    BLOCKED_PATHS.has(normalizedPath) ||
    normalizedPath.startsWith('/node_modules') ||
    normalizedPath.includes('/.')
  ) {
    return res.status(404).send('Not Found');
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: 'ignore' }));

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
