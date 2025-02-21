// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
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

// Voz para TTS según OpenAI (modelos: alloy, ash, coral, echo, etc.)
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
  Esta función administra el flujo:
  • Acumula chunks de audio.
  • Usa un timer de 700ms para detectar final del habla.
  • Cuando hay silencio, convierte (si es g711_ulaw) y envía a Whisper para transcripción.
  • Consulta GPT y luego solicita TTS mediante /v1/audio/speech.
  • Para llamadas (g711_ulaw) se pide TTS en WAV y se convierte a g711_ulaw para entregar el audio correcto.
  • Se detectan interrupciones: se ignoran los chunks de baja amplitud y se limpia el buffer al finalizar TTS.
*/
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  let interruptionScheduled = false;
  const SILENCE_THRESHOLD = 700; // ms de silencio

  const systemMsg = (audioFormat === 'g711_ulaw') ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: 'system', content: systemMsg });

  // Simula entrada inicial ("Hola!") para arrancar la conversación.
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

        // Para audio g711_ulaw: calcular amplitud promedio
        if (audioFormat === 'g711_ulaw') {
          let sum = 0;
          for (let i = 0; i < chunkBuffer.length; i++) {
            const sample = ulawToLinear(chunkBuffer[i]);
            sum += Math.abs(sample);
          }
          const avgAmplitude = sum / chunkBuffer.length;
          const threshold = botSpeaking ? 3000 : 50;
          if (avgAmplitude < threshold) {
            return; // Ignorar eco/ruido
          }
        }

        // Si el bot está hablando, marcar interrupción
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

  async function processUserAudio() {
    if (userAudioChunks.length === 0) return;
    const audioBuffer = Buffer.concat(userAudioChunks);
    userAudioChunks = []; // Limpiar buffer para evitar eco del TTS
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

  async function transcribeAudio(audioBuffer) {
    try {
      if (audioBuffer.length === 0) return null;
      const formData = new FormData();
      // Crear la vista Uint8Array usando buffer, byteOffset y byteLength
      const arr = new Uint8Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength);
      const blob = new Blob([arr], { type: 'audio/wav' });
      formData.append('file', blob, 'audio.wav');
      formData.append('model', 'whisper-1');
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: formData
      });
      const data = await response.json();
      return data.text;
    } catch (error) {
      console.error("Error llamando a la API Whisper:", error);
      return null;
    }
  }

  async function synthesizeAndStreamTTS(text) {
    try {
      console.log("Sintetizando TTS para el texto:", text);
      ttsCancel = false;
      // Para llamadas g711_ulaw, solicitamos WAV para luego convertir; para web usamos mp3.
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

      // Si es para Twilio, convertimos el WAV a g711_ulaw
      if (audioFormat === "g711_ulaw") {
        audioBuffer = convertWavToG711Ulaw(audioBuffer);
        console.log("Convertido a G711 ulaw, longitud (bytes):", audioBuffer.length);
      }
      
      botSpeaking = true;
      const chunkSize = 1600; // Ajustar según sea necesario
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
        // Simula reproducción en tiempo real (ej. 200ms por chunk)
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      // Limpiar el buffer de entrada tras TTS para evitar eco.
      userAudioChunks = [];
      botSpeaking = false;
    } catch (error) {
      console.error("Error en la síntesis TTS:", error);
    }
  }

  // --- Funciones de conversión de audio ---
  function convertG711UlawToWav(ulawBuffer) {
    const pcmSamples = new Int16Array(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcmSamples[i] = ulawToLinear(ulawBuffer[i]);
    }
    const wavHeader = createWavHeader(pcmSamples.length, 8000, 1, 16);
    const pcmBuffer = Buffer.from(pcmSamples.buffer);
    return Buffer.concat([wavHeader, pcmBuffer]);
  }

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

  function convertWavToG711Ulaw(wavBuffer) {
    const headerSize = 44; // Header estándar
    const { sampleRate, numChannels, bitsPerSample } = parseWavHeader(wavBuffer);
    const pcmData = wavBuffer.slice(headerSize);
    let inputPCM = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
    if (sampleRate !== 8000) {
      inputPCM = resamplePCM(inputPCM, sampleRate, 8000);
    }
    const numSamples = inputPCM.length;
    const ulawBuffer = Buffer.alloc(numSamples);
    for (let i = 0; i < numSamples; i++) {
      ulawBuffer[i] = linearToUlaw(inputPCM[i]);
    }
    return ulawBuffer;
  }

  function parseWavHeader(buffer) {
    const sampleRate = buffer.readUInt32LE(24);
    const numChannels = buffer.readUInt16LE(22);
    const bitsPerSample = buffer.readUInt16LE(34);
    return { sampleRate, numChannels, bitsPerSample };
  }

  function resamplePCM(inputSamples, inputRate, outputRate) {
    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(inputSamples.length / ratio);
    const outputSamples = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      outputSamples[i] = inputSamples[Math.floor(i * ratio)];
    }
    return outputSamples;
  }

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

// Registrar endpoints para Twilio y la web
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("Cliente Twilio conectado");
    setupMediaStreamHandler(connection, "g711_ulaw");
  });
});

fastify.register(async function (fastify) {
  fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
    console.log("Cliente web conectado");
    setupMediaStreamHandler(connection, "webm_opus");
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
