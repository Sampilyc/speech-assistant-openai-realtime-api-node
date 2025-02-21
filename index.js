/***************************************************************************
 * index.js (Node >=18)
 * -------------------------------------------------------------------------
 * 1) Recibe llamadas Twilio en /incoming-call -> TwiML -> /media-stream (WS)
 * 2) Captura audio G711 ulaw
 * 3) STT con Whisper (OpenAI)
 * 4) GPT-4 streaming + ElevenLabs TTS streaming
 * 5) Interrupciones + Silencio a 10s y 20s
 ***************************************************************************/
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Cargar variables de entorno
dotenv.config();

// Variables env
const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVEN_VOICE_ID,
  PORT = 5050
} = process.env;

// Verificaciones
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

// Mensajes de sistema
const SYSTEM_MESSAGE = `
Sos Gastón. Atención al cliente de Molinos. Porteño, simpático y no monótono.
Indagá bien el reclamo, luego pedí datos, etc. Al final avisa que se envió correo.
`.trim();

// Tiempo de silencio
const SILENCE_WARNING_MS = 10000; // a los 10s => "¿Hola, estás ahí?"
const SILENCE_CUTOFF_MS = 20000;  // a los 20s => colgar

// Creamos Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------------------------------------------------------------------
// PEQUEÑO DECODIFICADOR G.711 μ-law => PCM 16 bits, 8kHz
// (Sin librerías extra; ojo que la calidad es limitada)
// ---------------------------------------------------------------------
function ulawToPcm16(ulawByte) {
  // Tabla aproximada basada en estándar μ-law
  // Reference: https://en.wikipedia.org/wiki/%CE%9C-law_algorithm
  // Esto es un decode manual simplificado
  const u = ~ulawByte & 0xFF;
  let sign = (u & 0x80);
  let exponent = (u >> 4) & 0x07;
  let mantissa = (u & 0x0F);
  let sample = (0x21 << exponent) * mantissa + (0x21 >> 1);
  if (sign !== 0) sample = -sample;
  return sample;
}

// Decodifica un buffer entero de G.711 ulaw a PCM 16 bits (8 kHz)
function decodeG711Ulaw(bufferUlaw) {
  const out = new Int16Array(bufferUlaw.length);
  for (let i = 0; i < bufferUlaw.length; i++) {
    out[i] = ulawToPcm16(bufferUlaw[i]);
  }
  return out; // Int16Array
}

// Reescala 8kHz -> 16kHz duplicando muestras (muy rudimentario)
function upsample8to16(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    out[2*i]   = pcm8k[i];
    out[2*i+1] = pcm8k[i];
  }
  return out;
}

// Convierte un Int16Array a Buffer (ByteLength = length*2)
function int16ToBuffer(int16arr) {
  const buf = Buffer.alloc(int16arr.length * 2);
  for (let i = 0; i < int16arr.length; i++) {
    buf.writeInt16LE(int16arr[i], i*2);
  }
  return buf;
}

// ---------------------------------------------------------------------
// 1) Endpoint raíz
// ---------------------------------------------------------------------
fastify.get('/', async (req, reply) => {
  return { status: 'ok', message: 'Servidor Twilio+GPT4+ElevenLabs+Whisper' };
});

// ---------------------------------------------------------------------
// 2) /incoming-call => TwiML
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// 3) /media-stream => WebSocket con Twilio
// ---------------------------------------------------------------------
fastify.register(async function (instance) {
  instance.get('/media-stream', { websocket: true }, (connection) => {
    console.log('>> Nueva llamada conectada a /media-stream');

    let streamSid = null;
    let silenceTimer = null;
    let userSilent = false;
    let isBotSpeaking = false;
    let ttsAbortController = null;

    // Buffer de audio PCM (16 bits, 16kHz) que iremos armando
    let audioChunks = [];

    // GPT-4: historial de mensajes
    const conversation = [
      { role: 'system', content: SYSTEM_MESSAGE }
    ];

    // Detectar silencio
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      userSilent = false;
      // 10s => "¿Hola, estás ahí?"
      silenceTimer = setTimeout(async () => {
        userSilent = true;
        // Enviamos "¿Hola, estás ahí?" como si fuera usuario
        conversation.push({
          role: 'user',
          content: '¿Hola, estás ahí?'
        });
        await gpt4andSpeak(null);
        // 10s más => colgar
        silenceTimer = setTimeout(() => {
          console.log('>> Cortando la llamada por 20s de silencio');
          connection.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    // Abortar TTS en curso (si el usuario interrumpe)
    function abortTtsIfAny() {
      if (ttsAbortController) {
        console.log('>> Abortando TTS actual por interrupción');
        ttsAbortController.abort();
        ttsAbortController = null;
      }
      isBotSpeaking = false;
    }

    // Enviar audio a Twilio en base64
    function sendAudioToTwilio(base64Audio) {
      if (streamSid) {
        connection.socket.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64Audio }
        }));
      }
    }

    // -----------------------------------------------------------------
    // STT con Whisper (OpenAI) => pasamos un buffer WAV 16k
    // Construimos multipart/form-data manual (sin form-data)
    // -----------------------------------------------------------------
    async function transcribeWithWhisper(wavBuffer) {
      // 1) construimos el boundary
      const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);

      // 2) armamos la parte "file"
      // Observa que hay que poner el filename y content-type
      let body = '';
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`;
      body += `Content-Type: audio/wav\r\n\r\n`;
      // body + binary data + \r\n
      const headerBuf = Buffer.from(body, 'utf-8');
      const footerStr = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n--${boundary}--\r\n`;
      const footerBuf = Buffer.from(footerStr, 'utf-8');

      const fullBody = Buffer.concat([headerBuf, wavBuffer, footerBuf]);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: fullBody
      });
      if (!res.ok) {
        console.error('Error STT Whisper:', await res.text());
        return '';
      }
      const json = await res.json();
      if (json?.text) return json.text.trim();
      return '';
    }

    // -----------------------------------------------------------------
    // Convertimos PCM16 16k en un WAV básico en memoria
    // (44 bytes de cabecera + data)
    // -----------------------------------------------------------------
    function pcm16ToWavBuffer(pcm16Buffer, sampleRate = 16000) {
      // Crear header WAV
      const numChannels = 1;
      const byteRate = sampleRate * numChannels * 2; // 16 bits -> 2 bytes
      const blockAlign = numChannels * 2;
      const dataSize = pcm16Buffer.length;
      const chunkSize = 36 + dataSize;

      const buffer = Buffer.alloc(44 + dataSize);
      // RIFF header
      buffer.write('RIFF', 0); // 4 bytes
      buffer.writeUInt32LE(chunkSize, 4); // 4 bytes
      buffer.write('WAVE', 8); // 4 bytes
      // fmt subchunk
      buffer.write('fmt ', 12); // 4 bytes
      buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
      buffer.writeUInt16LE(1, 20);  // AudioFormat (1=PCM)
      buffer.writeUInt16LE(numChannels, 22); // NumChannels
      buffer.writeUInt32LE(sampleRate, 24);  // SampleRate
      buffer.writeUInt32LE(byteRate, 28);    // ByteRate
      buffer.writeUInt16LE(blockAlign, 32);  // BlockAlign
      buffer.writeUInt16LE(16, 34);          // BitsPerSample
      // data subchunk
      buffer.write('data', 36); // 4 bytes
      buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size
      // data
      pcm16Buffer.copy(buffer, 44, 0);

      return buffer;
    }

    // -----------------------------------------------------------------
    // GPT-4 + TTS (ElevenLabs streaming)
    // 1) Se le pasa un "user text" (opcional). Si hay userText, se hace push.
    // 2) Llamamos ChatCompletions streaming => parse SSE => por token => TTS
    // -----------------------------------------------------------------
    async function gpt4andSpeak(userText) {
      if (userText) {
        conversation.push({ role: 'user', content: userText });
      }
      isBotSpeaking = true;

      // Llamar GPT-4 streaming
      const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: conversation,
          temperature: 0.8,
          stream: true
        })
      });

      if (!gptRes.ok) {
        console.error('Error GPT-4:', await gptRes.text());
        isBotSpeaking = false;
        return;
      }

      // Parseamos SSE manualmente
      const reader = gptRes.body.getReader();
      let botText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = new TextDecoder().decode(value);
        // SSE => líneas separadas por \n
        const lines = chunkStr.split('\n');
        for (const line of lines) {
          const l = line.trim();
          if (l.startsWith('data:')) {
            const dataStr = l.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') {
              break;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const token = parsed.choices?.[0]?.delta?.content || '';
              if (token) {
                botText += token;
                // Hacer TTS de este token
                if (!isBotSpeaking) break; // por si se interrumpió
                await speakToken(token);
              }
            } catch (err) {
              // ignora
            }
          }
        }
      }

      if (botText.trim().length > 0) {
        conversation.push({ role: 'assistant', content: botText.trim() });
      }
      isBotSpeaking = false;
    }

    // -----------------------------------------------------------------
    // speakToken => llama a ElevenLabs en streaming, reenvía chunk
    // -----------------------------------------------------------------
    async function speakToken(token) {
      if (!isBotSpeaking) return;
      ttsAbortController = new AbortController();
      const signal = ttsAbortController.signal;

      // Petición a ElevenLabs streaming
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
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
        if (!isBotSpeaking) break; // si se interrumpió
        if (value) {
          // Convertimos chunk binario => base64 => Twilio
          const b64 = Buffer.from(value).toString('base64');
          sendAudioToTwilio(b64);
        }
      }

      ttsAbortController = null;
    }

    // -----------------------------------------------------------------
    // Procesar buffer => transcribir => GPT => TTS
    // -----------------------------------------------------------------
    async function processAudioAndRespond(pcm16kBuffer) {
      // Crear WAV
      const wavBuf = pcm16ToWavBuffer(pcm16kBuffer);
      // Subir a Whisper
      const text = await transcribeWithWhisper(wavBuf);
      if (text) {
        console.log('>> Usuario dice:', text);
        // Llamar GPT-4 + TTS
        await gpt4andSpeak(text);
      }
    }

    // -----------------------------------------------------------------
    // Chequeo si el usuario terminó de hablar cada 1s
    // -----------------------------------------------------------------
    let lastBufferLength = 0;
    const speechInterval = setInterval(async () => {
      if (audioChunks.length > 0) {
        const total = audioChunks.reduce((acc, buf) => acc + buf.length, 0);
        if (total === lastBufferLength && total > 0) {
          // no creció => fin de habla
          // unimos en un solo buffer
          const combined = Buffer.concat(audioChunks);
          audioChunks = [];
          // decodificar g711 => upsample => STT => GPT => TTS
          const pcm8k = decodeG711Ulaw(combined);  // Int16Array
          const pcm16k = upsample8to16(pcm8k);     // Int16Array
          const buf16 = int16ToBuffer(pcm16k);
          await processAudioAndRespond(buf16);
        }
        lastBufferLength = total;
      } else {
        lastBufferLength = 0;
      }
    }, 1000);

    // -----------------------------------------------------------------
    // Manejo de mensajes WS Twilio
    // -----------------------------------------------------------------
    connection.socket.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return console.error('>> Mensaje no-JSON:', msg);
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('>> Twilio streaming START, SID=', streamSid);
          resetSilenceTimer();
          break;

        case 'media':
          // Llega G.711
          resetSilenceTimer();
          if (isBotSpeaking) {
            // Interrupción => abortar TTS
            abortTtsIfAny();
          }
          if (data.media?.payload) {
            const chunk = Buffer.from(data.media.payload, 'base64');
            audioChunks.push(chunk);
          }
          break;

        case 'mark':
          // Twilio "mark" => no lo usamos
          break;

        case 'stop':
          console.log('>> Twilio streaming STOP');
          break;

        default:
          // console.log('>> Evento Twilio desconocido:', data.event);
          break;
      }
    });

    // -----------------------------------------------------------------
    // Al cerrar => limpiamos
    // -----------------------------------------------------------------
    connection.socket.on('close', () => {
      console.log('>> Llamada finalizada (WS closed)');
      clearInterval(speechInterval);
      if (silenceTimer) clearTimeout(silenceTimer);
      abortTtsIfAny();
    });
  });
});

// ---------------------------------------------------------------------
// Iniciar servidor
// ---------------------------------------------------------------------
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Error iniciando servidor:', err);
    process.exit(1);
  }
  console.log(`>> Servidor escuchando en ${address}`);
});
