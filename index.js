/****************************************************************************
 * index.js
 * --------------------------------------------------------------------------
 * Usa SÓLO:
 *   - fastify
 *   - @fastify/formbody
 *   - @fastify/websocket
 *   - dotenv
 *   - ws
 *
 * Flujo:
 *   1) Twilio llama /incoming-call -> TwiML -> reproduce MP3 -> abre wss://.../media-stream
 *   2) Al llegar event:'start', el bot "habla primero" => GPT-4 => ElevenLabs TTS
 *   3) Se transcribe STT con Whisper cuando el usuario hable
 *   4) Interrupciones (si usuario habla, aborta TTS)
 *   5) Silencio 10s => "¿Hola, estás ahí?" ; 20s => cuelga
 ****************************************************************************/

import Fastify from 'fastify';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Cargar variables de entorno
dotenv.config();

// Variables de entorno
const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVEN_VOICE_ID,
  PORT
} = process.env;

// Verificamos
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
Sos Gastón de Molinos. Hablás como porteño, simpático, no monótono.
Indagá bien el reclamo antes de pedir datos y al final avisá que se envió un correo.
`.trim();

// Silencio
const SILENCE_WARNING_MS = 10000;
const SILENCE_CUTOFF_MS = 20000;

// Creamos server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ------------------------------------------------------------------
// Funciones de decodificación G.711 u-law y upsample
// ------------------------------------------------------------------
function ulawByteToPcm16(ulaw) {
  const u = ~ulaw & 0xFF;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let sample = (0x21 << exponent) * mantissa + (0x21 >> 1);
  if (sign !== 0) sample = -sample;
  return sample;
}

function decodeG711Ulaw(buffer) {
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

function int16ArrayToBuffer(int16arr) {
  const buf = Buffer.alloc(int16arr.length * 2);
  for (let i = 0; i < int16arr.length; i++) {
    buf.writeInt16LE(int16arr[i], i*2);
  }
  return buf;
}

function buildWavPCM(pcm16Buf, sampleRate=16000) {
  const numCh = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numCh * (bitsPerSample / 8);
  const blockAlign = numCh * (bitsPerSample / 8);
  const dataSize = pcm16Buf.length;
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
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm16Buf.copy(wav, 44);
  return wav;
}

// ------------------------------------------------------------------
// Ruta raíz
// ------------------------------------------------------------------
fastify.get('/', async (req, reply) => {
  reply.send({ status: 'ok', message: 'Servidor Twilio + GPT4 + ElevenLabs + Whisper' });
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
// Helper: build multipart/form-data a mano para Whisper
// ------------------------------------------------------------------
function buildMultipartWav(wavBuf) {
  const boundary = '----Boundary' + Math.random().toString(16).slice(2);
  const fields = {
    model: 'whisper-1',
    language: 'es'
  };
  let headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  };

  let preFile = `--${boundary}\r\n`;
  preFile += `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`;
  preFile += `Content-Type: audio/wav\r\n\r\n`;

  let postFile = `\r\n`;
  for (let k in fields) {
    postFile += `--${boundary}\r\n`;
    postFile += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
    postFile += `${fields[k]}\r\n`;
  }
  postFile += `--${boundary}--\r\n`;

  const preFileBuf = Buffer.from(preFile, 'utf-8');
  const postFileBuf = Buffer.from(postFile, 'utf-8');
  const body = Buffer.concat([preFileBuf, wavBuf, postFileBuf]);

  return { body, headers };
}

// ------------------------------------------------------------------
// STT con Whisper
// ------------------------------------------------------------------
async function sttWhisper(wavBuf) {
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

// ------------------------------------------------------------------
// GPT-4 SSE => ElevenLabs TTS
// ------------------------------------------------------------------
async function gpt4AndSpeak(conversation, userMsg, sendAudioCb, onInterruptionCb) {
  if (userMsg) {
    conversation.push({ role: 'user', content: userMsg });
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

  let assistantTxt = '';
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
            assistantTxt += token;
            // TTS
            const aborted = await speakToken(token, sendAudioCb, onInterruptionCb);
            if (aborted) break reading;
          }
        } catch {/* ignore */}
      }
    }
  }

  if (assistantTxt.trim()) {
    conversation.push({ role: 'assistant', content: assistantTxt.trim() });
  }
}

// ------------------------------------------------------------------
// Llamar ElevenLabs streaming para cada token
// ------------------------------------------------------------------
async function speakToken(token, sendAudioCb, onInterruptionCb) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;

  let aborted = false;
  onInterruptionCb(() => {
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
  instance.get('/media-stream', { websocket: true }, (conn) => {
    console.log('>> Llamada conectada /media-stream');

    let streamSid = null;
    let conversation = [
      { role: 'system', content: SYSTEM_MESSAGE }
    ];
    let isBotSpeaking = false;
    let interruptionCb = null;

    // Buffer
    let audioChunks = [];
    let lastLen = 0;

    // Timers
    let silenceTimer = null;
    let userSilent = false;

    // => Bot talk first en "start"
    async function botInitialHello() {
      // Forzamos un primer mensaje
      isBotSpeaking = true;
      console.log('>> El bot saluda primero...');
      await gpt4AndSpeak(
        conversation,
        'Hola, soy Gastón de Molinos. ¿En qué puedo ayudarte hoy?',
        (b64) => {
          // Enviar chunk a Twilio
          if (streamSid) {
            conn.socket.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: b64 }
            }));
          }
        },
        (cb) => {
          // Func que la llama se lleva para abortar
          interruptionCb = cb;
        }
      );
      isBotSpeaking = false;
    }

    // Silencio
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      userSilent = false;
      silenceTimer = setTimeout(async () => {
        userSilent = true;
        conversation.push({ role: 'user', content: '¿Hola, estás ahí?' });
        isBotSpeaking = true;
        console.log('>> Silencio: Bot pregunta si está ahí');
        await gpt4AndSpeak(
          conversation,
          null,
          (b64) => {
            if (streamSid) {
              conn.socket.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: b64 }
              }));
            }
          },
          (cb) => { interruptionCb = cb; }
        );
        isBotSpeaking = false;

        // 10s más => colgar
        silenceTimer = setTimeout(() => {
          console.log('>> Cortamos por 20s de silencio');
          conn.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    function abortTtsIfAny() {
      if (interruptionCb) {
        console.log('>> Abortando TTS por interrupción');
        interruptionCb();
        interruptionCb = null;
      }
      isBotSpeaking = false;
    }

    // STT => GPT
    async function processAudio(pcm16k) {
      const wav = buildWavPCM(pcm16k, 16000);
      const text = await sttWhisper(wav);
      if (text) {
        console.log('>> Usuario dice:', text);
        isBotSpeaking = true;
        await gpt4AndSpeak(
          conversation,
          text,
          (b64) => {
            if (streamSid) {
              conn.socket.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: b64 }
              }));
            }
          },
          (cb) => { interruptionCb = cb; }
        );
        isBotSpeaking = false;
      }
    }

    // Detectar fin de habla
    const speechInterval = setInterval(async () => {
      if (audioChunks.length > 0) {
        const total = audioChunks.reduce((acc, b) => acc + b.length, 0);
        if (total === lastLen && total > 0) {
          const combined = Buffer.concat(audioChunks);
          audioChunks = [];
          const int16_8k = decodeG711Ulaw(combined);
          const int16_16k = upsample8kTo16k(int16_8k);
          const buf16 = int16ArrayToBuffer(int16_16k);
          await processAudio(buf16);
        }
        lastLen = total;
      } else {
        lastLen = 0;
      }
    }, 1000);

    // Handle WS Twilio
    conn.socket.on('message', (msg) => {
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
          // => El bot habla primero
          botInitialHello();
          break;

        case 'media':
          resetSilenceTimer();
          if (isBotSpeaking) {
            abortTtsIfAny();
          }
          if (data.media?.payload) {
            const buf = Buffer.from(data.media.payload, 'base64');
            audioChunks.push(buf);
          }
          break;

        case 'mark':
          break;

        case 'stop':
          console.log('>> Twilio streaming STOP');
          break;

        default:
          // console.log('No event:', data);
          break;
      }
    });

    conn.socket.on('close', () => {
      console.log('>> /media-stream cerrado');
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
    console.error('Error al iniciar:', err);
    process.exit(1);
  }
  console.log(`>> Servidor Twilio+GPT4+ElevenLabs en ${address}`);
});
