/*******************************************************************
 * index.js
 * ---------------------------------------------------------------
 * Ejemplo de servidor Fastify con Twilio Media Streams + GPT-4 + 
 * STT (OpenAI Whisper) + TTS (ElevenLabs streaming).
 * Soporta:
 *  - Conversación fluida
 *  - Interrupciones (el usuario puede hablar mientras TTS habla)
 *  - Detección de silencios a 10s (pregunta "¿estás ahí?") y 20s (cuelga)
 * 
 * Requisitos:
 *   npm install fastify @fastify/formbody @fastify/websocket dotenv axios form-data g711 wav readline
 *   - Configura en tu .env:
 *     OPENAI_API_KEY="tu_api_key_de_openai"
 *     ELEVENLABS_API_KEY="tu_api_key_de_elevenlabs"
 *     ELEVEN_VOICE_ID="tu_voice_id_en_elevenlabs"
 *******************************************************************/

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';

// Para decodificar G.711 u-law a PCM lineal
import { Decoder } from 'g711';

// Para crear WAV en memoria y poder mandarlo a Whisper
import wav from 'wav';

// Para procesar la respuesta streaming de ElevenLabs
import readline from 'readline';

dotenv.config();

const { OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVEN_VOICE_ID } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Falta la variable OPENAI_API_KEY en .env');
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error('Falta la variable ELEVENLABS_API_KEY en .env');
  process.exit(1);
}
if (!ELEVEN_VOICE_ID) {
  console.error('Falta la variable ELEVEN_VOICE_ID en .env (ID de la voz de ElevenLabs)');
  process.exit(1);
}

// Mensaje de sistema para GPT-4
const SYSTEM_MESSAGE = `
Sos Gastón. Atención al cliente de la empresa Molinos Rio de la Plata. 
Sos argentino, hablás como un porteño (usando "tenés", "acá", "sh" en "ll", etc.).
Sos simpático y servicial, sin ser monótono.
El cliente hace uno de 4 trámites (reclamos, consultas, gestión comercial o sugerencias).
Primero, indagá bien el reclamo (comentario) y luego pedí los datos obligatorios de cada gestión.
Al final, avisa que se envió un correo y despídete.
`;

// Control de silencios
const SILENCE_WARNING_MS = 10000; // 10 segundos => "¿Hola, estás ahí?"
const SILENCE_CUTOFF_MS = 20000;  // 20 segundos => colgar

// Creamos nuestro servidor Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Puerto
const PORT = process.env.PORT || 5050;

// Endpoint raíz (para test)
fastify.get('/', async (req, reply) => {
  return { status: 'ok', message: 'Servidor Twilio + GPT-4 + ElevenLabs corriendo' };
});

/**
 * Twilio llama a /incoming-call => responde TwiML => reproduce un audio de bienvenida y 
 * conecta el audio de la llamada a ws://.../media-stream
 */
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

/**
 * /media-stream => WebSocket con Twilio que recibe y envía audio en tiempo real
 */
fastify.register(async function (fastifyInstance) {
  fastifyInstance.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Nueva llamada conectada a /media-stream');

    let streamSid = null;

    // Historial para GPT-4 (comienza con la instrucción de sistema)
    const conversationHistory = [
      { role: 'system', content: SYSTEM_MESSAGE.trim() }
    ];

    // Manejamos un buffer de audio para cada "turno" de usuario,
    // y un flag para saber si el bot está "hablando" (TTS en curso).
    let isBotSpeaking = false;
    let ttsAbortController = null; // Para interrumpir TTS cuando el usuario hable
    let audioChunks = []; // guardaremos pequeños trozos de audio en PCM

    // Control de silencios
    let silenceTimer = null;
    let warningSent = false;

    // === Helpers ===

    // Reinicia o setea el timer de silencio
    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      warningSent = false;
      // A los 10s => "¿Hola, estás ahí?"
      silenceTimer = setTimeout(async () => {
        warningSent = true;
        await sendBotMessage("¿Hola, estás ahí?");
        // 10s más => colgar
        silenceTimer = setTimeout(() => {
          console.log('Cortando la llamada por inactividad...');
          connection.socket.close();
        }, SILENCE_CUTOFF_MS - SILENCE_WARNING_MS);
      }, SILENCE_WARNING_MS);
    }

    // Envía chunk de audio a Twilio
    function sendAudioToTwilio(base64Audio) {
      if (streamSid) {
        const msg = {
          event: 'media',
          streamSid,
          media: { payload: base64Audio }
        };
        connection.socket.send(JSON.stringify(msg));
      }
    }

    // Aborta la síntesis TTS en curso
    function abortTtsIfAny() {
      if (ttsAbortController) {
        console.log('Abortando TTS en curso por interrupción del usuario...');
        ttsAbortController.abort();
        ttsAbortController = null;
      }
      isBotSpeaking = false;
    }

    // Llamamos a GPT-4 y luego a TTS
    async function sendBotMessage(userText) {
      try {
        // Si userText no es null => push al historial
        if (userText) {
          conversationHistory.push({ role: 'user', content: userText });
        }

        // Llamar a GPT-4 en modo streaming
        isBotSpeaking = true;
        const gptResponse = await axios({
          method: 'POST',
          url: 'https://api.openai.com/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          data: {
            model: 'gpt-4',
            messages: conversationHistory,
            temperature: 0.8,
            stream: true
          },
          responseType: 'stream'
        });

        let assistantText = ''; // acumular la respuesta final

        const rl = readline.createInterface({ input: gptResponse.data });
        for await (const line of rl) {
          const cleanLine = line.trim();
          if (!cleanLine.startsWith('data:')) {
            continue;
          }
          const jsonStr = cleanLine.replace(/^data:\s?/, '');
          if (jsonStr === '[DONE]') {
            break; // fin del streaming
          }
          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              assistantText += token;
              // Enviar este pedacito por TTS (streaming ElevenLabs)
              await speakPartialText(token);
            }
          } catch (err) {
            // no pasa nada
          }
        }

        // Al terminar la respuesta, guardamos en historial
        if (assistantText.trim().length > 0) {
          conversationHistory.push({ role: 'assistant', content: assistantText.trim() });
        }
        isBotSpeaking = false;

      } catch (err) {
        console.error('Error al llamar GPT-4:', err.message);
        isBotSpeaking = false;
      }
    }

    // TTS con ElevenLabs en modo streaming
    async function speakPartialText(textFragment) {
      if (!isBotSpeaking) return; // si en el medio se interrumpió
      // Creamos un AbortController
      const controller = new AbortController();
      ttsAbortController = controller;

      try {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
        const payload = {
          text: textFragment,
          voice_settings: {
            // Ajusta según tus gustos
            stability: 0.3,
            similarity_boost: 0.75
          }
        };

        const ttsResponse = await axios({
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
          },
          data: payload,
          responseType: 'stream',
          signal: controller.signal
        });

        // ElevenLabs responde audio/mpeg en streaming
        // Lo leemos chunk por chunk y lo enviamos a Twilio en base64
        for await (const chunk of ttsResponse.data) {
          // chunk es un Buffer
          const b64 = chunk.toString('base64');
          sendAudioToTwilio(b64);
        }

      } catch (err) {
        if (err.name === 'CanceledError') {
          // Se abortó => normal
        } else {
          console.error('Error en TTS ElevenLabs:', err.message);
        }
      } finally {
        ttsAbortController = null;
      }
    }

    // Convierte el buffer PCM en un WAV en memoria, y lo envía a Whisper STT
    async function transcribeAudioPcm16kMono(buffer) {
      // buffer: PCM lineal 16 bits, 16 kHz, mono
      // Creamos un WAV en memoria
      const wavWriter = new wav.Writer({
        channels: 1,
        sampleRate: 16000,
        bitDepth: 16
      });

      // Recuerda que wav.Writer es un Stream, así que para crear un buffer final:
      const chunks = [];
      wavWriter.on('data', (data) => {
        chunks.push(data);
      });

      // Escribimos el buffer PCM
      wavWriter.write(buffer);
      wavWriter.end();

      // Esperamos a que termine
      await new Promise((resolve) => {
        wavWriter.on('finish', resolve);
      });

      const wavBuffer = Buffer.concat(chunks);

      // Llamar a Whisper
      const formData = new FormData();
      formData.append('file', wavBuffer, {
        contentType: 'audio/wav',
        filename: 'audio.wav'
      });
      formData.append('model', 'whisper-1');
      // Asumimos español
      formData.append('language', 'es');

      try {
        const sttRes = await axios.post(
          'https://api.openai.com/v1/audio/transcriptions',
          formData,
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              ...formData.getHeaders()
            }
          }
        );

        if (sttRes.data && sttRes.data.text) {
          return sttRes.data.text.trim();
        }
        return '';

      } catch (err) {
        console.error('Error al transcribir con Whisper:', err.response?.data || err.message);
        return '';
      }
    }

    // Decodifica G.711 u-law => PCM lineal 16 bits, 8kHz.
    // Luego se "reescala" a 16kHz duplicando muestras (muy rudimentario).
    function decodeG711ToPCM(ulawBuffer) {
      // Decodificamos u-law a 8kHz PCM (8 bits? en realidad 16 bits. 
      // La librería g711.Decoder() devuelve 16-bit PCM?)
      let pcm8k = Decoder.ulawToBuffer(ulawBuffer);

      // *Súper rudimentario*: duplicar muestras para obtener 16kHz
      // (Mejor usar un resampler real con sox o ffmpeg, pero a modo de ejemplo "funciona")
      const out = Buffer.alloc(pcm8k.length * 2);
      for (let i = 0; i < pcm8k.length; i += 2) {
        // Cada muestra 16 bits
        const sample = pcm8k.readInt16LE(i);
        // Duplicamos
        out.writeInt16LE(sample, i * 2);
        out.writeInt16LE(sample, i * 2 + 2);
      }
      return out;
    }

    // Detecta si hay algo en audioChunks => si sí, los unimos, transcribimos, limpiamos buffer
    async function processUserAudio() {
      if (audioChunks.length === 0) return;
      const combined = Buffer.concat(audioChunks);
      audioChunks = [];
      // Transcribir
      const text = await transcribeAudioPcm16kMono(combined);
      if (text) {
        console.log('Usuario dice:', text);
        // Llamar GPT-4
        await sendBotMessage(text);
      }
    }

    // === Handlers de eventos WebSocket con Twilio ===
    connection.socket.on('message', async (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        return console.error('Mensaje no-JSON recibido:', message);
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('Twilio streaming START, SID:', streamSid);
          // Reiniciar timmer de silencio
          resetSilenceTimer();
          break;

        case 'media': {
          // Llegan datos de audio G.711
          // Marcamos que hay actividad => reiniciamos silencio
          resetSilenceTimer();
          // Si el bot está hablando => interrumpir
          if (isBotSpeaking) {
            abortTtsIfAny();
          }

          // Guardamos el chunk decodificado
          const audioData = data.media.payload ? Buffer.from(data.media.payload, 'base64') : null;
          if (audioData) {
            // Decodificar G.711 u-law => PCM 16k
            const pcm16k = decodeG711ToPCM(audioData);
            audioChunks.push(pcm16k);
          }
          break;
        }

        case 'mark':
          // Twilio avisa que recibió una marca
          break;

        case 'stop':
          // Twilio cortó
          console.log('Twilio STOP');
          break;

        default:
          // Otros eventos
          // console.log('Evento desconocido:', data.event);
          break;
      }
    });

    // Usamos un setInterval p. ej. para detectar "final" del habla del usuario.
    // Si el usuario deja de hablar ~1s, procesamos STT.
    let lastBufferLength = 0;
    setInterval(async () => {
      if (audioChunks.length > 0) {
        const totalLength = audioChunks.reduce((acc, b) => acc + b.length, 0);
        if (totalLength === lastBufferLength && totalLength > 0) {
          // No creció el buffer => se asume que el usuario terminó de hablar
          // Transcribimos
          await processUserAudio();
        }
        lastBufferLength = totalLength;
      }
    }, 1000);

    // Manejo de cierre
    connection.socket.on('close', () => {
      console.log('Conexión WS con Twilio cerrada');
      if (silenceTimer) clearTimeout(silenceTimer);
      abortTtsIfAny();
    });
  });
});

// Iniciamos el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Error al iniciar servidor:', err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
