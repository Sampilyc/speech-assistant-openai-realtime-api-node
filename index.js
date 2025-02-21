/****************************************************************************
 * index.js
 * --------------------------------------------------------------------------
 * Mismas dependencias que tu ejemplo original:
 *   - fastify
 *   - @fastify/formbody
 *   - @fastify/websocket
 *   - dotenv
 *   - ws
 *
 * Funcionalidad:
 * 1) Recibe la llamada Twilio en /incoming-call => TwiML => reproduce MP3
 * 2) Abre WebSocket a /media-stream => audio G.711 ulaw
 * 3) Detecta fin de frase => STT con Whisper => GPT-4 SSE => ElevenLabs TTS
 * 4) Interrupciones si usuario habla mientras TTS
 * 5) Silencio 10s => "¿Hola, estás ahí?"; 20s => cuelga
 ****************************************************************************/

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Cargar variables de entorno
dotenv.config();

// Variables de entorno (Heroku)
const {
  OPENAI_API_KEY,      // Whisper + GPT-4
  ELEVENLABS_API_KEY,  // ElevenLabs TTS
  ELEVEN_VOICE_ID,     // Voz de Eleven
  PORT
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('Falta la variable OPENAI_API_KEY');
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error('Falta la variable ELEVENLABS_API_KEY');
  process.exit(1);
}
if (!ELEVEN_VOICE_ID) {
  console.error('Falta la variable ELEVEN_VOICE_ID');
  process.exit(1);
}

// Mensaje de sistema (similar al original)
const SYSTEM_MESSAGE = `
Sos Gastón. Atención al cliente de la empresa Molinos Rio de la Plata.
Sos argentino, hablás como un porteño (usando "tenés", "acá", "sh" en "ll", etc.).
Sos simpático y servicial, sin tono monótono.
Indagá bien el reclamo o gestión antes de pedir datos, y al final avisá que se envió un correo.
`.trim();

// Control de silencios
const SILENCE_WARNING_MS = 10000; // 10s => "¿Hola, estás ahí?"
const SILENCE_CUTOFF_MS = 20000;  // 20s => colgar

// Crear servidor Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ------------------------------------------------------------------
// Decodificación G.711 μ-law -> PCM 16 bits
// (Función simplificada sin librerías extras)
// ------------------------------------------------------------------
function ulawByteToPcm16(ulaw) {
  // Decodificación aproximada estándar
  const u = ~ulaw & 0xFF;
  const sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0F;
  let sample = (0x21 << exponent) * mantissa + (0x21 >> 1);
  if (sign !== 0) sample = -sample;
  return sample;
}

// Decodifica un Buffer con bytes μ-law => Int16Array (8kHz)
function decodeG711Ulaw(bufferUlaw) {
  const out = new Int16Array(bufferUlaw.length);
  for (let i = 0; i < bufferUlaw.length; i++) {
    out[i] = ulawByteToPcm16(bufferUlaw[i]);
  }
  return out;
}

// Duplica muestras 8kHz => 16kHz (extremadamente básico)
function upsample8kTo16k(int16arr8k) {
  const out = new Int16Array(int16arr8k.length * 2);
  for (let i = 0; i < int16arr8k.length; i++) {
    out[2 * i] = int16arr8k[i];
    out[2 * i + 1] = int16arr8k[i];
  }
  return out;
}

// Convierte Int16Array a Buffer
function int16ArrayToBuffer(int16arr) {
  const buf = Buffer.alloc(int16arr.length * 2);
  for (let i = 0; i < int16arr.length; i++) {
    buf.writeInt16LE(int16arr[i], i * 2);
  }
  return buf;
}

// Genera un WAV (mono, 16 bits, sampleRate) en memoria
function buildWavPCM(pcm16Buffer, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm16Buffer.length;
  const chunkSize = 36 + dataSize;

  const wav = Buffer.alloc(44 + dataSize);
  // RIFF
  wav.write('RIFF', 0);
  wav.writeUInt32LE(chunkSize, 4);
  wav.write('WAVE', 8);
  // fmt
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // Subchunk1Size
  wav.writeUInt16LE(1, 20);  // PCM
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  // data
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm16Buffer.copy(wav, 44);

  return wav;
}

// ------------------------------------------------------------------
// Ruta raíz (debug)
// ------------------------------------------------------------------
fastify.get('/', async (req, reply) => {
  reply.send({ status: 'ok', message: 'Servidor Twilio + GPT4 + ElevenLabs + Whisper' });
});

// ------------------------------------------------------------------
// /incoming-call => TwiML (reproduce el MP3 y crea WebSocket /media-stream)
// ------------------------------------------------------------------
fastify.all('/incoming-call', async (req, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// ------------------------------------------------------------------
// Helper: build multipart/form-data a mano (para Whisper)
// ------------------------------------------------------------------
function buildMultipartFormData(bufferWav, fields) {
  // Creamos un boundary
  const boundary = '----Boundary' + Math.random().toString(16).slice(2);
  let headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  };

  // Armar el body con el WAV + campos
  // 1) file
  let preFile = `--${boundary}\r\n`;
  preFile += `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`;
  preFile += `Content-Type: audio/wav\r\n\r\n`;

  let postFile = `\r\n`;
  // Campos
  for (let k in fields) {
    postFile += `--${boundary}\r\n`;
    postFile += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
    postFile += `${fields[k]}\r\n`;
  }
  postFile += `--${boundary}--\r\n`;

  // Convertimos a Buffer
  const preFileBuf = Buffer.from(preFile, 'utf-8');
  const postFileBuf = Buffer.from(postFile, 'utf-8');
  const body = Buffer.concat([preFileBuf, bufferWav, postFileBuf]);

  return { body, headers };
}

// ------------------------------------------------------------------
// /media-stream => WebSocket Twilio
// ------------------------------------------------------------------
fastify.register(async function (instance) {
  instance.get('/media-stream', { websocket: true }, (connection) => {
    console.log('>> Llamada conectada a /media-stream');

    let streamSid = null;
    let isBotSpeaking = false;
    let ttsAbortController = null;
    let silenceTimer = null;
    let userSilent = false;

    // Buffer de audio G.711
    let audioChunks = [];
    let lastBufferLen = 0;

    // Historial GPT
    const conversation = [
      { role: 'system', content: SYSTEM_MESSAGE }
    ];

    // Timer de silencio
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      userSilent = false;
      // A los 10s => "¿Hola, estás ahí?"
      silenceTimer = setTimeout(async () => {
        userSilent = true;
        conversation.push({ role: 'user', content: '¿Hola, estás ahí?' });
        await callGptAndSpeak(null);

        // 10s más => colgar
        silenceTimer = setTimeout(() => {
          console.log('>> Cortando por 20s de silencio');
          connection.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    // Abortar TTS
    function abortTtsIfAny() {
      if (ttsAbortController) {
        console.log('>> Abortando TTS por interrupción');
        ttsAbortController.abort();
      }
      isBotSpeaking = false;
    }

    // Enviar audio a Twilio
    function sendAudioChunk(base64Audio) {
      if (!streamSid) return;
      connection.socket.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: base64Audio }
      }));
    }

    // STT con Whisper
    async function sttWhisper(wavBuffer) {
      // Armamos multipart
      const { body, headers } = buildMultipartFormData(wavBuffer, {
        model: 'whisper-1',
        language: 'es'
      });

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers,
        body
      });
      if (!res.ok) {
        console.error('Error Whisper STT:', await res.text());
        return '';
      }
      const json = await res.json();
      return json.text?.trim() || '';
    }

    // GPT-4 SSE => ElevenLabs
    async function callGptAndSpeak(userText) {
      if (userText) {
        conversation.push({ role: 'user', content: userText });
      }
      isBotSpeaking = true;

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
        isBotSpeaking = false;
        return;
      }

      let assistantText = '';
      const reader = gptRes.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = new TextDecoder().decode(value);
        const lines = chunkStr.split('\n');
        for (let line of lines) {
          line = line.trim();
          if (line.startsWith('data:')) {
            const dataStr = line.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const token = parsed.choices?.[0]?.delta?.content || '';
              if (token) {
                assistantText += token;
                // TTS
                if (!isBotSpeaking) break;
                await speakToken(token);
              }
            } catch { /* ignore */ }
          }
        }
      }

      if (assistantText.trim()) {
        conversation.push({ role: 'assistant', content: assistantText.trim() });
      }
      isBotSpeaking = false;
    }

    // Llamar a ElevenLabs TTS streaming para cada token
    async function speakToken(token) {
      if (!isBotSpeaking) return;
      ttsAbortController = new AbortController();
      const signal = ttsAbortController.signal;

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
        return;
      }

      const reader = ttsRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isBotSpeaking) break;
        if (value) {
          const b64 = Buffer.from(value).toString('base64');
          sendAudioChunk(b64);
        }
      }

      ttsAbortController = null;
    }

    // Procesar el buffer => decodificar => 16k => WAV => STT => GPT
    async function processAudio(pcm16kBuffer) {
      const wav = buildWavPCM(pcm16kBuffer, 16000);
      const text = await sttWhisper(wav);
      if (text) {
        console.log('>> Usuario dice:', text);
        await callGptAndSpeak(text);
      }
    }

    // Revisar fin de habla cada 1s
    const speechChecker = setInterval(async () => {
      if (audioChunks.length > 0) {
        const totalLen = audioChunks.reduce((acc, buf) => acc + buf.length, 0);
        if (totalLen === lastBufferLen && totalLen > 0) {
          // Fin de habla => transcribir
          const combined = Buffer.concat(audioChunks);
          audioChunks = [];
          // decode g711 => upsample => buffer
          const int16_8k = decodeG711Ulaw(combined);
          const int16_16k = upsample8kTo16k(int16_8k);
          const buf16 = int16ArrayToBuffer(int16_16k);
          await processAudio(buf16);
        }
        lastBufferLen = totalLen;
      } else {
        lastBufferLen = 0;
      }
    }, 1000);

    // ----------------------------------------------------------------
    // Manejo de mensajes Twilio WS
    // ----------------------------------------------------------------
    connection.socket.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return console.error('Mensaje no JSON:', msg);
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('>> Twilio streaming START', streamSid);
          resetSilenceTimer();
          break;

        case 'media':
          // Si el bot habla => abortar TTS
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
          // do nothing
          break;

        case 'stop':
          console.log('>> Twilio streaming STOP');
          break;

        default:
          // console.log('>> Evento Twilio desconocido:', data);
          break;
      }
    });

    // Al cerrar WS
    connection.socket.on('close', () => {
      console.log('>> Llamada finalizada (WS cerrado)');
      clearInterval(speechChecker);
      if (silenceTimer) clearTimeout(silenceTimer);
      abortTtsIfAny();
    });
  });
});

// Iniciar el server
const PORT_FINAL = PORT || 5050;
fastify.listen({ port: PORT_FINAL, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Error iniciando servidor:', err);
    process.exit(1);
  }
  console.log(`>> Servidor Twilio+GPT4+ElevenLabs en ${address}`);
});
