/*******************************************************************
 * index.js
 * ---------------------------------------------------------------
 * Ejemplo "producción" con:
 *   - Twilio Media Streams (G.711 u-law)
 *   - Resample con Sox de 8kHz a 16kHz
 *   - Whisper STT (OpenAI)
 *   - GPT-4 (ChatCompletion streaming)
 *   - ElevenLabs TTS streaming
 *   - Interrupciones (cuando el usuario habla, se aborta TTS)
 *   - Detección de silencios (10s => "¿Hola, estás ahí?"; 20s => colgar)
 *
 * Variables de entorno (set en Heroku config vars):
 *   OPENAI_API_KEY
 *   ELEVENLABS_API_KEY
 *   ELEVEN_VOICE_ID
 *   PORT=5050 (puedes ajustarlo)
 *
 * Dependencias (package.json):
 *   fastify @fastify/formbody @fastify/websocket axios form-data g711 wav readline uuid
 *   + tener sox instalado en el sistema
 *******************************************************************/

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import axios from 'axios';
import FormData from 'form-data';
import { Decoder } from 'g711';
import wav from 'wav';
import readline from 'readline';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// Leemos variables de entorno directamente (sin dotenv)
const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVEN_VOICE_ID,
  PORT = 5050,
} = process.env;

// Validamos que existan
if (!OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY en las variables de entorno');
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error('Falta ELEVENLABS_API_KEY en las variables de entorno');
  process.exit(1);
}
if (!ELEVEN_VOICE_ID) {
  console.error('Falta ELEVEN_VOICE_ID en las variables de entorno');
  process.exit(1);
}

// Mensaje de sistema (rol "system") que define el comportamiento de GPT-4
const SYSTEM_MESSAGE = `
Sos Gastón. Atención al cliente de la empresa Molinos Rio de la Plata. 
Sos argentino, hablás como un porteño (usando "tenés", "acá", "sh" en "ll", etc.).
Sos amable y no monótono.
Recordá los 4 trámites: reclamos, consultas, gestión comercial, sugerencias. 
Primero, obtener un comentario detallado. Luego pedir datos específicos. 
Al final, avisa que se enviará un correo y despídete.
`;

// Control de silencios
const SILENCE_WARNING_MS = 10000; // 10s => "¿Hola, estás ahí?"
const SILENCE_CUTOFF_MS = 20000;  // 20s => colgar

// Creamos servidor Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

//////////////////////////////////////////////////////////////////////////
// 1) Endpoint raíz (debug)
//////////////////////////////////////////////////////////////////////////
fastify.get('/', async (req, reply) => {
  return {
    status: 'ok',
    message: 'Servidor Twilio + GPT-4 + ElevenLabs en producción',
    envOpenAI: !!OPENAI_API_KEY,
    envEleven: !!ELEVENLABS_API_KEY
  };
});

//////////////////////////////////////////////////////////////////////////
// 2) /incoming-call => TwiML que conecta la llamada al WebSocket /media-stream
//////////////////////////////////////////////////////////////////////////
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

//////////////////////////////////////////////////////////////////////////
// 3) /media-stream => WebSocket con Twilio (audio G.711 en tiempo real)
//////////////////////////////////////////////////////////////////////////
fastify.register(async function (fastifyInstance) {
  fastifyInstance.get('/media-stream', { websocket: true }, (connection) => {
    console.log('>> Conexión WS Twilio /media-stream iniciada');

    // Identificador de la transmisión Twilio
    let streamSid = null;

    // Historial para GPT-4
    const conversation = [
      { role: 'system', content: SYSTEM_MESSAGE.trim() }
    ];

    // Banderas y buffers
    let isBotSpeaking = false;       // indica si el bot está hablando (TTS en curso)
    let ttsAbortController = null;   // para abortar TTS si hay interrupción
    let audioBufferChunks = [];      // almacenamos buffers G.711 => resample => STT
    let silenceTimer = null;         // timeout para silencios
    let warningSent = false;         // si ya se envió el "¿Hola, estás ahí?"
    let lastBufferLength = 0;        // para detectar fin de habla

    ////////////////////////////////////////////////////////////////////////
    // Helper: Reinicia/establece el timer de silencio
    ////////////////////////////////////////////////////////////////////////
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      warningSent = false;

      // A los 10s: "¿Hola, estás ahí?"
      silenceTimer = setTimeout(async () => {
        warningSent = true;
        await sendBotMessage('¿Hola, estás ahí?');

        // 10s más => colgar
        silenceTimer = setTimeout(() => {
          console.log('>> Cortando la llamada por inactividad (20s)');
          connection.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    ////////////////////////////////////////////////////////////////////////
    // Helper: Enviar audio a Twilio (base64)
    ////////////////////////////////////////////////////////////////////////
    function sendAudioToTwilio(base64Chunk) {
      if (!streamSid) return;
      const msg = {
        event: 'media',
        streamSid,
        media: { payload: base64Chunk }
      };
      connection.socket.send(JSON.stringify(msg));
    }

    ////////////////////////////////////////////////////////////////////////
    // Abortamos TTS en curso
    ////////////////////////////////////////////////////////////////////////
    function abortTtsIfAny() {
      if (ttsAbortController) {
        console.log('>> Abortando TTS en curso (interrupción usuario)');
        ttsAbortController.abort();
        ttsAbortController = null;
      }
      isBotSpeaking = false;
    }

    ////////////////////////////////////////////////////////////////////////
    // GPT-4: enviamos mensaje de usuario al historial, generamos respuesta
    ////////////////////////////////////////////////////////////////////////
    async function sendBotMessage(userText) {
      try {
        if (userText) {
          conversation.push({ role: 'user', content: userText });
        }

        isBotSpeaking = true;

        // Petición streaming a GPT-4
        const gptRes = await axios({
          method: 'POST',
          url: 'https://api.openai.com/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          data: {
            model: 'gpt-4',
            messages: conversation,
            stream: true,
            temperature: 0.8
          },
          responseType: 'stream'
        });

        let fullAssistantText = '';

        // Procesamos chunk a chunk
        const rl = readline.createInterface({ input: gptRes.data });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.replace(/^data:\s?/, '');
          if (jsonStr === '[DONE]') {
            break; // fin
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              fullAssistantText += token;
              // Enviamos este trozo a TTS
              await speakPartialText(token);
            }
          } catch (err) {
            // ignora
          }
        }

        if (fullAssistantText.trim().length > 0) {
          conversation.push({ role: 'assistant', content: fullAssistantText.trim() });
        }

        isBotSpeaking = false;
      } catch (err) {
        console.error('>> Error en GPT-4:', err.message);
        isBotSpeaking = false;
      }
    }

    ////////////////////////////////////////////////////////////////////////
    // TTS con ElevenLabs en modo streaming: speakPartialText
    ////////////////////////////////////////////////////////////////////////
    async function speakPartialText(textFragment) {
      if (!isBotSpeaking) return; // puede que se haya interrumpido
      ttsAbortController = new AbortController();
      const signal = ttsAbortController.signal;

      try {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
        const payload = {
          text: textFragment,
          voice_settings: {
            stability: 0.3,
            similarity_boost: 0.75
          }
        };

        const ttsRes = await axios({
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY,
          },
          data: payload,
          responseType: 'stream',
          signal
        });

        // ElevenLabs responde audio en chunks (MPEG). Los enviamos a Twilio en base64
        for await (const chunk of ttsRes.data) {
          if (!isBotSpeaking) break;
          const b64 = chunk.toString('base64');
          sendAudioToTwilio(b64);
        }
      } catch (err) {
        if (err.name === 'CanceledError') {
          // Interrumpido => normal
        } else {
          console.error('>> Error en TTS ElevenLabs:', err.message);
        }
      } finally {
        ttsAbortController = null;
      }
    }

    ////////////////////////////////////////////////////////////////////////
    // STT: decodificar G.711 => PCM => resample => WAV => Whisper
    ////////////////////////////////////////////////////////////////////////
    async function transcribeAudioBuffer(buffer) {
      // 1. Decodifica G.711 u-law => PCM 16 bits, 8 kHz
      const pcm8k = Decoder.ulawToBuffer(buffer);

      // 2. Llama a sox para convertir PCM raw 8k a WAV 16k
      return new Promise((resolve, reject) => {
        const sox = spawn('sox', [
          // Formato de entrada: raw PCM 16 bits, 1 canal, 8k
          '-t', 'raw',
          '-b', '16',
          '-e', 'signed-integer',
          '-r', '8000',
          '-c', '1',
          '-',
          // salida en WAV 16k, 1 canal, 16 bits
          '-t', 'wav',
          '-r', '16000',
          '-c', '1',
          '-'
        ]);

        sox.stdin.write(pcm8k);
        sox.stdin.end();

        let wavBufferChunks = [];
        sox.stdout.on('data', (chunk) => {
          wavBufferChunks.push(chunk);
        });

        sox.stderr.on('data', (data) => {
          // console.error('sox stderr:', data.toString());
        });

        sox.on('close', async (code) => {
          if (code !== 0) {
            return reject(new Error(`sox proceso terminó con código ${code}`));
          }

          const wavBuffer = Buffer.concat(wavBufferChunks);

          // 3. Llamar a Whisper
          try {
            const formData = new FormData();
            formData.append('file', wavBuffer, {
              contentType: 'audio/wav',
              filename: `audio_${uuidv4()}.wav`
            });
            formData.append('model', 'whisper-1');
            formData.append('language', 'es');

            const sttResponse = await axios.post(
              'https://api.openai.com/v1/audio/transcriptions',
              formData,
              {
                headers: {
                  Authorization: `Bearer ${OPENAI_API_KEY}`,
                  ...formData.getHeaders()
                }
              }
            );

            if (sttResponse.data && sttResponse.data.text) {
              resolve(sttResponse.data.text.trim());
            } else {
              resolve('');
            }
          } catch (err) {
            console.error('>> Error en Whisper STT:', err.response?.data || err.message);
            resolve('');
          }
        });
      });
    }

    ////////////////////////////////////////////////////////////////////////
    // Detección de "fin de habla" => transcribir
    ////////////////////////////////////////////////////////////////////////
    async function processIfUserFinishedSpeaking() {
      if (audioBufferChunks.length === 0) return;

      // Unimos todo
      const combined = Buffer.concat(audioBufferChunks);
      audioBufferChunks = [];

      // Transcribimos
      const text = await transcribeAudioBuffer(combined);
      if (text) {
        console.log('>> Usuario dice:', text);
        await sendBotMessage(text);
      }
    }

    ////////////////////////////////////////////////////////////////////////
    // WebSocket: manejar mensajes de Twilio
    ////////////////////////////////////////////////////////////////////////
    connection.socket.on('message', async (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch (error) {
        return console.error('>> Mensaje no JSON recibido:', msg);
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('>> Twilio streaming START, SID:', streamSid);
          resetSilenceTimer();
          break;

        case 'media': {
          resetSilenceTimer();
          // Si el bot está hablando, lo interrumpimos
          if (isBotSpeaking) {
            abortTtsIfAny();
          }

          // Capturamos payload G.711
          const audioB64 = data.media.payload;
          if (audioB64) {
            const audioBuffer = Buffer.from(audioB64, 'base64');
            audioBufferChunks.push(audioBuffer);
          }
          break;
        }

        case 'mark':
          // Twilio avisa "mark"
          break;

        case 'stop':
          console.log('>> Twilio streaming STOP');
          break;

        default:
          break;
      }
    });

    ////////////////////////////////////////////////////////////////////////
    // Cada 1s revisamos si el usuario dejó de hablar => STT
    ////////////////////////////////////////////////////////////////////////
    setInterval(async () => {
      if (audioBufferChunks.length > 0) {
        const totalLen = audioBufferChunks.reduce((acc, b) => acc + b.length, 0);
        if (totalLen === lastBufferLength && totalLen > 0) {
          // No aumentó => asumo usuario terminó la frase
          await processIfUserFinishedSpeaking();
        }
        lastBufferLength = totalLen;
      } else {
        lastBufferLength = 0;
      }
    }, 1000);

    ////////////////////////////////////////////////////////////////////////
    // Manejo de cierre
    ////////////////////////////////////////////////////////////////////////
    connection.socket.on('close', () => {
      console.log('>> WS Twilio /media-stream cerrado');
      if (silenceTimer) clearTimeout(silenceTimer);
      abortTtsIfAny();
    });
  });
});

//////////////////////////////////////////////////////////////////////////
// 4) Iniciar servidor
//////////////////////////////////////////////////////////////////////////
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Error iniciando servidor:', err);
    process.exit(1);
  }
  console.log(`>> Servidor en producción escuchando en ${address}`);
});
