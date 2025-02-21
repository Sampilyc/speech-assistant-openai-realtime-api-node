// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
// Agrega esta importación para manejar FormData en Node
import FormData from 'form-data';
import { Buffer } from 'buffer';

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Falta la clave API de OpenAI. Por favor, establécela en las variables de entorno.');
  process.exit(1);
}
const PORT = process.env.PORT || 5050;

// Mensajes del sistema
const SYSTEM_MESSAGE = `Sos Gastón. Atención al cliente de Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, con acentuación y tonalidad característica. Decí "tenés" en lugar de "tienes" y "acá" en vez de "aquí".`;
const SYSTEM_MESSAGE_WEB = `Sos Gastón, la asistente virtual de Molinos Rio de la Plata.`;

// Ajusta el nombre de la voz si lo deseas; "echo" es la demo interna de OpenAI TTS
const VOICE = 'echo';

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Ruta raíz
fastify.get('/', async (req, reply) => {
  reply.send({ message: 'Servidor de Media Stream funcionando!' });
});

// Endpoint TwiML para Twilio (no modificar)
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

/*
  La función setupMediaStreamHandler administra el flujo de audio:
  - Acumula chunks de audio recibidos.
  - Usa un timer (700ms) para detectar silencio.
  - Cuando hay silencio, junta los chunks, convierte (si es g711_ulaw) y envía el audio a Whisper para transcripción.
  - Con la transcripción se consulta GPT y se genera una respuesta.
  - La respuesta se sintetiza con OpenAI TTS (voz "echo") y se transmite al cliente.
  - Se implementa un mecanismo de interrupción (timer "ignoreMediaUntil") para ignorar eco del TTS.
*/
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  let interruptionScheduled = false;
  const SILENCE_THRESHOLD = 700; // ms

  // Selección de mensaje del sistema
  const systemMsg = (audioFormat === 'g711_ulaw') ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: 'system', content: systemMsg });

  // Dispara una primera frase del bot (simulado)
  processUserUtterance("Hola!");

  // Variable para ignorar audio durante la reproducción del TTS
  let ignoreMediaUntil = 0;

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

        // Si estamos en período de ignorar (TTS) y la amplitud es baja, descartamos el chunk
        if (Date.now() < ignoreMediaUntil) {
          let sum = 0;
          for (let i = 0; i < chunkBuffer.length; i++) {
            const sample = ulawToLinear(chunkBuffer[i]);
            sum += Math.abs(sample);
          }
          const avgAmplitude = sum / chunkBuffer.length;
          if (avgAmplitude < 4000) {
            // Ruido muy bajo, ignoramos
            return;
          } else {
            // Ruido alto => interrupción
            console.log("Interrupción detectada (alto volumen durante TTS).");
            ttsCancel = true;
          }
        } 
        // Si no estamos en ignoreMediaUntil, procesamos:
        else if (audioFormat === 'g711_ulaw') {
          // Filtro normal de amplitud
          let sum = 0;
          for (let i = 0; i < chunkBuffer.length; i++) {
            const sample = ulawToLinear(chunkBuffer[i]);
            sum += Math.abs(sample);
          }
          const threshold = botSpeaking ? 3000 : 300;  // <-- Se sube un poco el threshold para evitar falsos "you"
          const avgAmplitude = sum / chunkBuffer.length;
          if (avgAmplitude < threshold) return;
        }

        // Si llegamos hasta acá, guardamos el chunk
        if (botSpeaking) {
          console.log("Interrupción detectada: el usuario habló mientras el bot hablaba");
          ttsCancel = true;
          if (!interruptionScheduled) {
            interruptionScheduled = true;
            setTimeout(() => {
              if (userAudioChunks.length > 0) processUserAudio();
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
    userAudioChunks = []; // Limpiamos para evitar eco

    let wavBuffer = (audioFormat === 'g711_ulaw')
      ? convertG711UlawToWav(audioBuffer)
      : audioBuffer;

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
          model: "gpt-4o",
          messages: messages,
          temperature: 0.8
        })
      });
      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content.trim();
      } else {
        console.error("Error en la respuesta de GPT:", data);
        return "Lo siento, no entendí tu consulta.";
      }
    } catch (error) {
      console.error("Error llamando a la API de GPT:", error);
      return "Error procesando tu consulta.";
    }
  }

  // Se reemplaza el uso de Blob/ArrayBuffer por un append directo de Buffer
  async function transcribeAudio(audioBuffer) {
    try {
      if (audioBuffer.length === 0) return null;

      const formData = new FormData();
      // Aquí especificamos 'filename' y 'contentType' para que Whisper lo interprete correctamente.
      formData.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
      formData.append('model', 'whisper-1');

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: formData
      });

      const data = await response.json();
      // data.text vendrá con la transcripción
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

      if (audioFormat === "g711_ulaw") {
        audioBuffer = convertWavToG711Ulaw(audioBuffer);
        console.log("Convertido a G711 ulaw, longitud (bytes):", audioBuffer.length);
      }

      // Estimamos la duración aproximada de reproducción
      const chunkSize = 1600; // 3200 bytes = 200ms? Twilio usa 8000Hz, 8-bit ulaw => ~1600 bytes ~ 200ms
      const numChunks = Math.ceil(audioBuffer.length / chunkSize);
      const playbackDuration = numChunks * 200; // ms

      ignoreMediaUntil = Date.now() + playbackDuration + 500;
      console.log("Ignorando media hasta:", ignoreMediaUntil);

      botSpeaking = true;

      // Envía el audio en chunks para que Twilio lo reproduzca progresivamente
      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (ttsCancel) {
          console.log("Reproducción TTS interrumpida.");
          break;
        }
        const chunk = audioBuffer.slice(i, i + chunkSize);
        connection.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        await new Promise(resolve => setTimeout(resolve, 200));
      }
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
    const headerSize = 44;
    const { sampleRate, numChannels } = parseWavHeader(wavBuffer);
    const pcmData = wavBuffer.slice(headerSize);

    let inputPCM = new Int16Array(
      pcmData.buffer,
      pcmData.byteOffset,
      pcmData.byteLength / 2
    );

    // Resample si no es 8000Hz
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
    // const bitsPerSample = buffer.readUInt16LE(34); // no siempre se usa, pero se puede leer
    return { sampleRate, numChannels };
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
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = numSamples * blockAlign;

    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
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

// Rutas websocket
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

// Inicia servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
