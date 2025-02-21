// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
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

const VOICE = 'echo';

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Ruta raíz
fastify.get('/', async (req, reply) => {
  reply.send({ message: 'Servidor de Media Stream funcionando!' });
});

// Endpoint TwiML para Twilio (se modifica para usar solo audio entrante)
fastify.all('/incoming-call', async (req, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" track="inbound" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});

/*
  Hemos modificado la lógica para:
    - Re-samplear a 16k antes de enviar a Whisper.
    - Forzar idioma (es) y añadir un prompt contextual.
    - Desactivar filtros agresivos de amplitud.
    - Aumentar el "silencio" a 1.5s para que se capture una frase completa.
*/
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  let interruptionScheduled = false;

  const SILENCE_THRESHOLD = 1500; // 1.5s de silencio

  // Selecciona el mensaje del sistema según el formato de audio
  const systemMsg = (audioFormat === 'g711_ulaw') ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: 'system', content: systemMsg });

  // Dispara una frase inicial del bot
  processUserUtterance("Hola!");

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

        // Si se está reproduciendo TTS y aún estamos en periodo de ignorar, descartamos el chunk (o interrumpimos si hay mucho volumen)
        if (Date.now() < ignoreMediaUntil) {
          let sum = 0;
          for (let i = 0; i < chunkBuffer.length; i++) {
            sum += Math.abs(ulawToLinear(chunkBuffer[i]));
          }
          const avgAmplitude = sum / chunkBuffer.length;
          if (avgAmplitude > 4000) {
            console.log("Interrupción detectada (alto volumen durante TTS).");
            ttsCancel = true;
          }
          return;
        }

        // Gating mínimo: si el audio es ultra bajo se descarta
        let sum = 0;
        for (let i = 0; i < chunkBuffer.length; i++) {
          sum += Math.abs(ulawToLinear(chunkBuffer[i]));
        }
        const avgAmplitude = sum / chunkBuffer.length;
        if (avgAmplitude < 20) return;

        // Si el bot está hablando, se interpreta como interrupción
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
    userAudioChunks = [];
    console.log("Procesando audio del usuario. Bytes:", audioBuffer.length);

    // Convertimos g711_ulaw a WAV de 16k; si es otro formato se deja tal cual
    let wav16k;
    if (audioFormat === 'g711_ulaw') {
      wav16k = convertG711UlawToWav16k(audioBuffer);
    } else {
      wav16k = audioBuffer;
    }

    const transcription = await transcribeAudio(wav16k);
    if (!transcription) {
      console.error("Error en la transcripción o vacío.");
      return;
    }
    console.log("Transcripción:", transcription);

    // Consulta a GPT con la transcripción
    conversationContext.push({ role: 'user', content: transcription });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en respuesta GPT.");
      return;
    }
    conversationContext.push({ role: 'assistant', content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  async function processUserUtterance(text) {
    console.log("Entrada textual de usuario:", text);
    conversationContext.push({ role: 'user', content: text });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en respuesta GPT.");
      return;
    }
    conversationContext.push({ role: 'assistant', content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  // Consulta a la API de GPT
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
        console.error("Error GPT:", data);
        return "Lo siento, no entendí tu consulta.";
      }
    } catch (error) {
      console.error("Error GPT fetch:", error);
      return "Error procesando tu consulta.";
    }
  }

  // Llamada a la API Whisper: forzamos idioma español, añadimos prompt y response_format=text
  async function transcribeAudio(wavBuffer) {
    try {
      if (wavBuffer.length === 0) return null;

      const formData = new FormData();
      formData.append('file', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'es');
      formData.append('response_format', 'text');
      formData.append('prompt', "Esta es una conversación en español (argentino). Por favor transcribir con naturalidad usando expresiones como 'acá' y 'tenés'.");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: formData
      });

      const result = await response.text();
      if (!result || result.includes('"error":')) {
        console.error("Respuesta Whisper con error o vacía:", result);
        return null;
      }
      return result.trim();
    } catch (error) {
      console.error("Error llamando a la API Whisper:", error);
      return null;
    }
  }

  // Llamada a la API TTS de OpenAI y envío del audio en chunks
  async function synthesizeAndStreamTTS(text) {
    try {
      console.log("Sintetizando TTS:", text);
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
        console.error("Error en API TTS:", response.statusText);
        return;
      }

      let audioBuffer = Buffer.from(await response.arrayBuffer());
      console.log("Audio TTS, bytes:", audioBuffer.length);

      if (audioFormat === "g711_ulaw") {
        audioBuffer = convertWavToG711Ulaw(audioBuffer);
        console.log("Convertido a G711 uLaw, bytes:", audioBuffer.length);
      }

      const chunkSize = 1600;
      const numChunks = Math.ceil(audioBuffer.length / chunkSize);
      const playbackDuration = numChunks * 200;
      ignoreMediaUntil = Date.now() + playbackDuration + 500;
      botSpeaking = true;

      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (ttsCancel) {
          console.log("TTS interrumpido.");
          break;
        }
        const chunk = audioBuffer.slice(i, i + chunkSize);
        connection.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        await new Promise(res => setTimeout(res, 200));
      }
      userAudioChunks = [];
      botSpeaking = false;
    } catch (error) {
      console.error("Error en la síntesis TTS:", error);
    }
  }

  // Convierte G711 uLaw a WAV de 16kHz
  function convertG711UlawToWav16k(ulawBuffer) {
    const pcm8k = new Int16Array(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcm8k[i] = ulawToLinear(ulawBuffer[i]);
    }
    const pcm16k = resamplePCM(pcm8k, 8000, 16000);
    const wavHeader = createWavHeader(pcm16k.length, 16000, 1, 16);
    const pcmBuffer = Buffer.from(pcm16k.buffer);
    return Buffer.concat([wavHeader, pcmBuffer]);
  }

  function ulawToLinear(ulawByte) {
    ulawByte = ~ulawByte;
    const sign = ulawByte & 0x80;
    const exponent = (ulawByte >> 4) & 0x07;
    const mantissa = ulawByte & 0x0F;
    let sample = (mantissa << 4) + 0x08;
    sample <<= exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
  }

  function convertWavToG711Ulaw(wavBuffer) {
    const headerSize = 44;
    const { sampleRate } = parseWavHeader(wavBuffer);
    const pcmData = wavBuffer.slice(headerSize);
    let inputPCM = new Int16Array(
      pcmData.buffer,
      pcmData.byteOffset,
      pcmData.byteLength / 2
    );
    if (sampleRate !== 8000) {
      inputPCM = resamplePCM(inputPCM, sampleRate, 8000);
    }
    const numSamples = inputPCM.length;
    const ulawBuf = Buffer.alloc(numSamples);
    for (let i = 0; i < numSamples; i++) {
      ulawBuf[i] = linearToUlaw(inputPCM[i]);
    }
    return ulawBuf;
  }

  function parseWavHeader(buffer) {
    const sampleRate = buffer.readUInt32LE(24);
    const numChannels = buffer.readUInt16LE(22);
    return { sampleRate, numChannels };
  }

  function resamplePCM(inputSamples, inputRate, outputRate) {
    const ratio = inputRate / outputRate;
    const outLen = Math.floor(inputSamples.length / ratio);
    const outSamples = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      outSamples[i] = inputSamples[Math.floor(i * ratio)];
    }
    return outSamples;
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
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
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

// Rutas WebSocket
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

// Iniciar servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
