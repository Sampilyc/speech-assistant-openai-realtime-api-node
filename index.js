// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch'; // Para llamadas HTTP a las APIs de OpenAI
import { Buffer, Blob } from 'buffer';

// Cargar variables de entorno
dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Falta la clave API de OpenAI. Por favor, establécela en las variables de entorno.');
  process.exit(1);
}

const PORT = process.env.PORT || 5050;

// Mensajes del sistema para cada modalidad
const SYSTEM_MESSAGE = `Sos Gastón. Atención al cliente de Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, con acentuación y tonalidad característica. Decí "tenés" en lugar de "tienes" y "acá" en vez de "aquí". Sos simpático, servicial y hablás de forma natural y rápida. Indagá siempre sobre lo que necesita el cliente antes de solicitar datos.`;
const SYSTEM_MESSAGE_WEB = `Sos Gastón, la asistente virtual de Molinos Rio de la Plata. Atendés al usuario que chatea desde la web.`;

// Voz para TTS según OpenAI (modelos soportados: alloy, ash, coral, echo, etc.)
const VOICE = 'echo';

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Ruta raíz para verificar el servidor
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Servidor de Media Stream funcionando!' });
});

// Endpoint TwiML para Twilio (no modificar)
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type('text/xml').send(twimlResponse);
});

/*
  Función que maneja el flujo de audio:
   - Acumula los chunks recibidos.
   - Usa un timer de silencio (700ms) para determinar fin de habla.
   - Al finalizar, convierte (si es g711_ulaw) y envía el audio a Whisper para transcripción.
   - Luego consulta GPT (Chat API) y, a partir de la respuesta, solicita TTS.
   - Si la conexión es para Twilio (audioFormat === "g711_ulaw"), se solicita TTS en WAV y se convierte a g711_ulaw,
     de modo que se reproduzca correctamente sin interferencias.
   - Se mantiene la detección de interrupciones para cancelar el TTS si el usuario empieza a hablar.
*/
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  let interruptionScheduled = false;
  const SILENCE_THRESHOLD = 700; // milisegundos de silencio

  // Agregar mensaje de sistema según modalidad
  const systemMsg = (audioFormat === 'g711_ulaw') ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: 'system', content: systemMsg });

  // Simula entrada inicial para arrancar la conversación
  processUserUtterance("Hola!");

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (userAudioChunks.length > 0) {
        processUserAudio();
      }
    }, SILENCE_THRESHOLD);
  }

  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log("Stream iniciado:", streamSid);
        return;
      }
      if (data.event === 'media') {
        const chunkBuffer = Buffer.from(data.media.payload, 'base64');

        // Para audio g711_ulaw: se puede filtrar parte del eco o interferencia (si se requiere ajuste adicional)
        // Aquí se podría calcular la amplitud y descartar chunks de muy baja o muy alta amplitud.
        // (Esta parte se puede afinar según la experiencia en producción)

        // Si el bot está reproduciendo TTS, detectamos posible interrupción
        if (botSpeaking) {
          console.log("Interrupción detectada: el usuario habló mientras el bot hablaba");
          ttsCancel = true;
          if (!interruptionScheduled) {
            interruptionScheduled = true;
            setTimeout(() => {
              if (userAudioChunks.length > 0) {
                processUserAudio();
              }
              interruptionScheduled = false;
            }, 500);
          }
        }

        userAudioChunks.push(chunkBuffer);
        resetSilenceTimer();
      }
    } catch (error) {
      console.error("Error al procesar mensaje entrante:", error);
    }
  });

  connection.on('close', () => {
    console.log("Conexión cerrada.");
    if (silenceTimer) clearTimeout(silenceTimer);
  });

  // Procesa el audio acumulado del usuario (al detectar silencio o interrupción)
  async function processUserAudio() {
    if (userAudioChunks.length === 0) return;
    const audioBuffer = Buffer.concat(userAudioChunks);
    userAudioChunks = [];
    let wavBuffer;
    if (audioFormat === 'g711_ulaw') {
      wavBuffer = convertG711UlawToWav(audioBuffer);
    } else {
      wavBuffer = audioBuffer;
    }
    console.log("Procesando audio del usuario, longitud (bytes):", wavBuffer.length);

    const transcription = await transcribeAudio(wavBuffer);
    if (!transcription) {
      console.error("Error en la transcripción.");
      return;
    }
    console.log("Transcripción:", transcription);
    conversationContext.push({ role: 'user', content: transcription });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en la respuesta de GPT.");
      return;
    }
    conversationContext.push({ role: 'assistant', content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  // Procesa una entrada directa del usuario (por ejemplo, "Hola!")
  async function processUserUtterance(text) {
    console.log("Procesando entrada de usuario:", text);
    conversationContext.push({ role: 'user', content: text });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en la respuesta de GPT.");
      return;
    }
    conversationContext.push({ role: 'assistant', content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  // Consulta la API de Chat de OpenAI (GPT‑4) para obtener la respuesta según el contexto.
  async function getGPTResponse(messages) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: messages,
          temperature: 0.8
        })
      });
      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content.trim();
      } else {
        console.error("Error en la respuesta de GPT:", data);
        return null;
      }
    } catch (error) {
      console.error("Error llamando a la API de GPT:", error);
      return null;
    }
  }

  // Llama a la API Whisper de OpenAI para transcribir el audio.
  async function transcribeAudio(audioBuffer) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.wav');
      formData.append('model', 'whisper-1');
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: formData
      });
      const data = await response.json();
      return data.text;
    } catch (error) {
      console.error("Error llamando a la API Whisper:", error);
      return null;
    }
  }

  // Función TTS: utiliza el endpoint de OpenAI para generar audio (speech)
  async function synthesizeAndStreamTTS(text) {
    try {
      console.log("Sintetizando TTS para el texto:", text);
      ttsCancel = false;
      // Si el flujo es para Twilio, solicitamos WAV para luego convertir a g711_ulaw;
      // en otro caso (por ejemplo, web) se solicita MP3.
      const ttsResponseFormat = (audioFormat === "g711_ulaw") ? "wav" : "mp3";
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: VOICE,
          response_format: ttsResponseFormat
        })
      });
      if (!response.ok) {
        console.error("Error en la API TTS:", response.statusText);
        return;
      }
      let audioBuffer = Buffer.from(await response.arrayBuffer());
      console.log("Audio TTS recibido, longitud (bytes):", audioBuffer.length);

      // Si es Twilio, convertimos el WAV a g711_ulaw
      if (audioFormat === "g711_ulaw") {
        audioBuffer = convertWavToG711Ulaw(audioBuffer);
        console.log("Convertido a G711 ulaw, longitud (bytes):", audioBuffer.length);
      }
      
      botSpeaking = true;
      const chunkSize = 1600; // Ajustar según corresponda
      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (ttsCancel) {
          console.log("Reproducción TTS interrumpida por el usuario.");
          break;
        }
        const chunk = audioBuffer.slice(i, i + chunkSize);
        connection.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        // Simula reproducción en tiempo real (por ejemplo, 200ms por chunk)
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      botSpeaking = false;
    } catch (error) {
      console.error("Error en la síntesis TTS:", error);
    }
  }

  // --- Funciones de conversión de audio ---

  // Convierte un Buffer de audio en g711_ulaw a un Buffer WAV (usado para audio de usuario)
  function convertG711UlawToWav(ulawBuffer) {
    const pcmSamples = new Int16Array(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcmSamples[i] = ulawToLinear(ulawBuffer[i]);
    }
    const wavHeader = createWavHeader(pcmSamples.length, 8000, 1, 16);
    const pcmBuffer = Buffer.from(pcmSamples.buffer);
    return Buffer.concat([wavHeader, pcmBuffer]);
  }

  // Conversión de μ-law a PCM lineal (16 bits)
  function ulawToLinear(ulawByte) {
    ulawByte = ~ulawByte;
    const sign = ulawByte & 0x80;
    const exponent = (ulawByte >> 4) & 0x07;
    const mantissa = ulawByte & 0x0F;
    let sample = (mantissa << 4) + 0x08;
    sample = sample << exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
  }

  // Nueva función: Convierte un WAV (header + PCM) a g711_ulaw
  function convertWavToG711Ulaw(wavBuffer) {
    const headerSize = 44; // Asumimos header estándar WAV
    const pcmDataLength = wavBuffer.length - headerSize;
    const numSamples = pcmDataLength / 2; // Muestras de 16 bits
    const ulawBuffer = Buffer.alloc(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const sample = wavBuffer.readInt16LE(headerSize + i * 2);
      ulawBuffer[i] = linearToUlaw(sample);
    }
    return ulawBuffer;
  }

  // Función para convertir muestra PCM a μ-law
  function linearToUlaw(sample) {
    const BIAS = 0x84;
    const MAX = 32635;
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > MAX) sample = MAX;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let ulawByte = ~(sign | (exponent << 4) | mantissa);
    return ulawByte & 0xFF;
  }

  // Crea un header WAV para datos PCM
  function createWavHeader(numSamples, sampleRate, numChannels, bitsPerSample) {
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = numSamples * numChannels * bitsPerSample / 8;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
  }
}

// Registrar endpoint para Twilio (audio en g711_ulaw)
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("Cliente Twilio conectado");
    setupMediaStreamHandler(connection, "g711_ulaw");
  });
});

// Registrar endpoint para la web (audio en webm_opus)
fastify.register(async function (fastify) {
  fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
    console.log("Cliente web conectado");
    setupMediaStreamHandler(connection, "webm_opus");
  });
});

// Iniciar el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
