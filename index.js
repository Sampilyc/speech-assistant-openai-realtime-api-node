/****************************************************************************
 * index.js
 * --------------------------------------------------------------------------
 * SÓLO usa:
 *   - fastify
 *   - @fastify/formbody
 *   - @fastify/websocket
 *   - dotenv
 *   - ws
 *
 * Cambios clave:
 *   - Envía tramas de silencio G.711 cada 1s (si no se está enviando TTS).
 *   - El bot habla primero al evento 'start'.
 *   - STT con Whisper, GPT-4 SSE, TTS con ElevenLabs.
 *   - Interrupción y silencio 10s/20s.
 ****************************************************************************/

import Fastify from 'fastify';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVEN_VOICE_ID,
  PORT
} = process.env;

// Validaciones
if (!OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY');
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error('Falta ELEVENLABS_API_KEY');
  process.exit(1);
}
if (!ELEVEN_VOICE_ID) {
  console.error('Falta ELEVEN_VOICE_ID');
  process.exit(1);
}

// Mensaje de sistema
const SYSTEM_MESSAGE = `
Sos Gastón, atención al cliente de Molinos.
Hablas como porteño, no monótono, amable.
Indagá bien el reclamo antes de pedir datos, al final avisá que se envió un correo.
`.trim();

// Silencios
const SILENCE_WARNING_MS = 10000;
const SILENCE_CUTOFF_MS = 20000;

// Crear Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/** ------------------------------------------------------------------
 *  Generar una trama de silencio G.711 μ-law de ~20ms
 *  Normalmente 8kHz => 160 muestras => 160 bytes
 *  μ-law de 0xFF ~ 0
 --------------------------------------------------------------------*/
function generateG711SilenceFrame() {
  const frameSize = 160; // ~ 20ms a 8kHz
  // 0xFF es el valor μ-law que corresponde a PCM = 0 (silencio)
  return Buffer.alloc(frameSize, 0xFF);
}

// ------------------------------------------------------------------
// Decodificación G.711 μ-law => PCM int16
// ------------------------------------------------------------------
function ulawByteToPcm16(ulaw) {
  const u = ~ulaw & 0xFF;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let sample = (0x21 << exponent) * mantissa + (0x21 >> 1);
  if (sign) sample = -sample;
  return sample;
}

function decodeG711(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = ulawByteToPcm16(buffer[i]);
  }
  return out;
}

function upsample8kTo16k(int16arr8k) {
  const out = new Int16Array(int16arr8k.length * 2);
  for (let i = 0; i < int16arr8k.length; i++) {
    out[2*i] = int16arr8k[i];
    out[2*i+1] = int16arr8k[i];
  }
  return out;
}

function int16ToBuffer(int16arr) {
  const buf = Buffer.alloc(int16arr.length * 2);
  for (let i = 0; i < int16arr.length; i++) {
    buf.writeInt16LE(int16arr[i], i*2);
  }
  return buf;
}

function buildWav(pcm16buf, sampleRate=16000) {
  const numCh = 1;
  const bps = 16;
  const byteRate = sampleRate * numCh * (bps/8);
  const blockAlign = numCh * (bps/8);
  const dataSize = pcm16buf.length;
  const chunkSize = 36 + dataSize;

  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(chunkSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numCh, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bps, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm16buf.copy(wav, 44);
  return wav;
}

// ------------------------------------------------------------------
// Ruta raíz
// ------------------------------------------------------------------
fastify.get('/', async (req, reply) => {
  reply.send({status:'ok', message:'Twilio+GPT4+ElevenLabs+Whisper con silencio G.711'});
});

// ------------------------------------------------------------------
// /incoming-call => TwiML
// ------------------------------------------------------------------
fastify.all('/incoming-call', async (req, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// ------------------------------------------------------------------
// Helper: build multipart a mano p/ Whisper
// ------------------------------------------------------------------
function buildMultipartWav(bufferWav) {
  const boundary = '----Boundary' + Math.random().toString(16).slice(2);
  const model = 'whisper-1';
  const lang = 'es';

  let headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  };

  let pre = `--${boundary}\r\n`;
  pre += `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`;
  pre += `Content-Type: audio/wav\r\n\r\n`;

  let post = `\r\n--${boundary}\r\n`;
  post += `Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`;
  post += `--${boundary}\r\n`;
  post += `Content-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`;
  post += `--${boundary}--\r\n`;

  const preBuf = Buffer.from(pre, 'utf-8');
  const postBuf = Buffer.from(post, 'utf-8');
  const body = Buffer.concat([preBuf, bufferWav, postBuf]);

  return { body, headers };
}

// STT con Whisper
async function whisperSTT(wavBuf) {
  const { body, headers } = buildMultipartWav(wavBuf);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers,
    body
  });
  if (!res.ok) {
    console.error('Error STT Whisper:', await res.text());
    return '';
  }
  const json = await res.json();
  return json.text?.trim() || '';
}

// GPT-4 SSE => ElevenLabs
async function gpt4AndTts(conversation, userText, sendAudioCb, getAbortSignal) {
  if (userText) {
    conversation.push({ role: 'user', content: userText });
  }

  const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: conversation,
      stream: true,
      temperature: 0.8
    })
  });

  if (!gptRes.ok) {
    console.error('Error GPT-4:', await gptRes.text());
    return;
  }

  let assistantText = '';
  const reader = gptRes.body.getReader();
  reading: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkStr = new TextDecoder().decode(value);
    const lines = chunkStr.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('data:')) {
        const dataStr = line.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') break reading;
        try {
          const parsed = JSON.parse(dataStr);
          const token = parsed.choices?.[0]?.delta?.content || '';
          if (token) {
            assistantText += token;
            const aborted = await speakToken(token, sendAudioCb, getAbortSignal);
            if (aborted) break reading;
          }
        } catch {/* ignore */}
      }
    }
  }

  if (assistantText.trim()) {
    conversation.push({ role: 'assistant', content: assistantText.trim() });
  }
}

async function speakToken(token, sendAudioCb, getAbortSignal) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  let aborted = false;

  // si getAbortSignal() se invoca => se llama ctrl.abort()
  getAbortSignal(() => {
    ctrl.abort();
    aborted = true;
  });

  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: token,
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.75
      }
    }),
    signal
  });

  if (!ttsRes.ok) {
    console.error('Error TTS Eleven:', await ttsRes.text());
    return false;
  }

  const reader = ttsRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (aborted) return true;
    if (value) {
      const b64 = Buffer.from(value).toString('base64');
      sendAudioCb(b64);
    }
  }
  return aborted;
}

// ------------------------------------------------------------------
// /media-stream => WS con Twilio
// ------------------------------------------------------------------
fastify.register(async function (instance) {
  instance.get('/media-stream', { websocket: true }, (connection) => {
    console.log('>> /media-stream: Llamada conectada');

    let streamSid = null;
    let conversation = [
      { role: 'system', content: SYSTEM_MESSAGE }
    ];

    // Flags
    let interruptionCb = null;
    let isBotSpeaking = false;
    let userSilent = false;

    // Audio buffer
    let audioChunks = [];
    let lastBufferLen = 0;

    // Silencio
    let silenceTimer = null;
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      userSilent = false;
      silenceTimer = setTimeout(async () => {
        userSilent = true;
        conversation.push({ role: 'user', content: '¿Hola, estás ahí?' });
        isBotSpeaking = true;
        await gpt4AndTts(
          conversation,
          null,
          (b64) => sendAudioToTwilio(b64),
          (cb) => { interruptionCb = cb; }
        );
        isBotSpeaking = false;
        silenceTimer = setTimeout(() => {
          console.log('>> Cortar por 20s sin hablar');
          connection.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    // Forzar bot: Hola ...
    async function botInitialHello() {
      isBotSpeaking = true;
      await gpt4AndTts(
        conversation,
        'Hola, soy Gastón de Molinos. ¿En qué puedo ayudarte hoy?',
        (b64) => sendAudioToTwilio(b64),
        (cb) => { interruptionCb = cb; }
      );
      isBotSpeaking = false;
    }

    // Abortar TTS
    function abortTtsIfAny() {
      if (interruptionCb) {
        console.log('>> Abortando TTS (interrupción)');
        interruptionCb();
        interruptionCb = null;
      }
      isBotSpeaking = false;
    }

    // Enviar chunk a Twilio
    function sendAudioToTwilio(base64Audio) {
      if (!streamSid) return;
      connection.socket.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: base64Audio }
      }));
    }

    // Intervalo de “silencio keepalive”
    // Envia ~20ms de silencio G.711 c/1s si NO estamos enviando TTS
    // Esto evita que Twilio corte si no hay tráfico
    const silenceInterval = setInterval(() => {
      if (!isBotSpeaking) {
        // Enviamos 20ms de silencio
        const silenceBuf = generateG711SilenceFrame();
        const b64 = silenceBuf.toString('base64');
        sendAudioToTwilio(b64);
      }
    }, 1000);

    // Detectar fin de habla
    const speechInterval = setInterval(async () => {
      if (audioChunks.length > 0) {
        const totalLen = audioChunks.reduce((acc, b) => acc + b.length, 0);
        if (totalLen === lastBufferLen && totalLen > 0) {
          // asumimos fin de habla
          const combined = Buffer.concat(audioChunks);
          audioChunks = [];
          const int16_8k = decodeG711(combined);
          const int16_16k = upsample8kTo16k(int16_8k);
          const buf16 = int16ToBuffer(int16_16k);
          const wavBuf = buildWav(buf16, 16000);

          const text = await whisperSTT(wavBuf);
          if (text) {
            console.log('>> Usuario dice:', text);
            isBotSpeaking = true;
            await gpt4AndTts(
              conversation,
              text,
              (b64) => sendAudioToTwilio(b64),
              (cb) => { interruptionCb = cb; }
            );
            isBotSpeaking = false;
          }
        }
        lastBufferLen = totalLen;
      } else {
        lastBufferLen = 0;
      }
    }, 1000);

    // Handler WS
    connection.socket.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('>> Twilio streaming START', streamSid);
          resetSilenceTimer();
          // Bot habla primero
          botInitialHello();
          break;

        case 'media':
          resetSilenceTimer();
          if (isBotSpeaking) {
            abortTtsIfAny();
          }
          if (data.media?.payload) {
            const audioBuf = Buffer.from(data.media.payload, 'base64');
            audioChunks.push(audioBuf);
          }
          break;

        case 'mark':
          break;

        case 'stop':
          console.log('>> Twilio streaming STOP');
          break;

        default:
          // console.log('Otro evento Twilio:', data);
          break;
      }
    });

    connection.socket.on('close', () => {
      console.log('>> WS /media-stream cerrado');
      clearInterval(silenceInterval);
      clearInterval(speechInterval);
      if (silenceTimer) clearTimeout(silenceTimer);
      abortTtsIfAny();
    });
  });
});

// Iniciar
const finalPort = PORT || 5050;
fastify.listen({ port: finalPort, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Error iniciando server:', err);
    process.exit(1);
  }
  console.log(`>> Servidor con keepalive de silencio, escuchando en ${address}`);
});
