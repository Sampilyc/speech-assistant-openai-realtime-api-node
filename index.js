// index.js
import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { Buffer } from 'buffer';

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Falta la clave API de OpenAI en las variables de entorno.");
  process.exit(1);
}
const PORT = process.env.PORT || 5050;

const SYSTEM_MESSAGE = "Sos Gastón. Atención al cliente de Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, con acentuación y tonalidad característica. Decí 'tenés' en lugar de 'tienes' y 'acá' en vez de 'aquí'.";
const SYSTEM_MESSAGE_WEB = "Sos Gastón, la asistente virtual de Molinos Rio de la Plata.";
const VOICE = "echo";

const app = Fastify();
app.register(fastifyFormBody);
app.register(fastifyWs);

// Ruta raíz
app.get("/", async (req, reply) => {
  reply.send({ message: "Servidor de Media Stream funcionando!" });
});

/*
  Endpoint inicial:
  - Reproduce el MP3 de bienvenida.
  - Luego redirige al endpoint que abre el stream para recibir el audio entrante.
*/
app.all("/incoming-call", async (req, reply) => {
  const host = req.headers.host;
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
      <Redirect>https://${host}/keep-call-alive</Redirect>
    </Response>
  `;
  reply.type("text/xml").send(twiml);
});

/*
  Endpoint para mantener la llamada activa y establecer el stream.
  Se configura para que Twilio envíe sólo el audio entrante (track="inbound").
*/
app.all("/keep-call-alive", async (req, reply) => {
  const host = req.headers.host;
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream" track="inbound" />
      </Connect>
      <Pause length="3600"/>
    </Response>
  `;
  reply.type("text/xml").send(twiml);
});

// WebSocket para recibir el audio
app.get("/media-stream", { websocket: true }, (connection, req) => {
  console.log("Cliente Twilio conectado al stream");
  setupMediaStreamHandler(connection, "g711_ulaw");
});

// Lógica del Media Stream
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  let interruptionScheduled = false;
  const SILENCE_THRESHOLD = 1500; // 1.5 segundos

  const systemMsg = (audioFormat === "g711_ulaw") ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: "system", content: systemMsg });

  // Envía una entrada inicial simulada del bot
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

  connection.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("Stream iniciado:", streamSid);
        return;
      }
      if (data.event === "media") {
        const chunkBuffer = Buffer.from(data.media.payload, "base64");
        if (Date.now() < ignoreMediaUntil) {
          let sum = 0;
          for (let i = 0; i < chunkBuffer.length; i++) {
            sum += Math.abs(ulawToLinear(chunkBuffer[i]));
          }
          const avg = sum / chunkBuffer.length;
          if (avg > 4000) {
            console.log("Interrupción detectada (alto volumen durante TTS).");
            ttsCancel = true;
          }
          return;
        }
        let sum = 0;
        for (let i = 0; i < chunkBuffer.length; i++) {
          sum += Math.abs(ulawToLinear(chunkBuffer[i]));
        }
        const avg = sum / chunkBuffer.length;
        if (avg < 20) return;
        if (botSpeaking) {
          console.log("Interrupción: el usuario habló mientras el bot hablaba");
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
    } catch (err) {
      console.error("Error procesando mensaje:", err);
    }
  });

  connection.on("close", () => {
    console.log("Conexión cerrada.");
    if (silenceTimer) clearTimeout(silenceTimer);
  });

  async function processUserAudio() {
    if (userAudioChunks.length === 0) return;
    const audioBuffer = Buffer.concat(userAudioChunks);
    userAudioChunks = [];
    console.log("Procesando audio del usuario. Bytes:", audioBuffer.length);
    let wav16k;
    if (audioFormat === "g711_ulaw") {
      wav16k = convertG711UlawToWav16k(audioBuffer);
    } else {
      wav16k = audioBuffer;
    }
    const transcription = await transcribeAudio(wav16k);
    if (!transcription) {
      console.error("Transcripción vacía o con error.");
      return;
    }
    console.log("Transcripción:", transcription);
    conversationContext.push({ role: "user", content: transcription });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en la respuesta de GPT.");
      return;
    }
    conversationContext.push({ role: "assistant", content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  async function processUserUtterance(text) {
    console.log("Entrada textual:", text);
    conversationContext.push({ role: "user", content: text });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en respuesta GPT.");
      return;
    }
    conversationContext.push({ role: "assistant", content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  async function getGPTResponse(messages) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
      const data = await res.json();
      if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content.trim();
      } else {
        console.error("Error GPT:", data);
        return "Lo siento, no entendí tu consulta.";
      }
    } catch (err) {
      console.error("Error al llamar a GPT:", err);
      return "Error procesando tu consulta.";
    }
  }

  async function transcribeAudio(wavBuffer) {
    try {
      if (wavBuffer.length === 0) return null;
      const form = new FormData();
      form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });
      form.append("model", "whisper-1");
      form.append("language", "es");
      form.append("response_format", "text");
      form.append("prompt", "Esta es una conversación en español (argentino). Transcribir con naturalidad usando expresiones como 'acá' y 'tenés'.");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: form
      });
      const text = await res.text();
      if (!text || text.includes('"error":')) {
        console.error("Error en respuesta de Whisper:", text);
        return null;
      }
      return text.trim();
    } catch (err) {
      console.error("Error al llamar a Whisper:", err);
      return null;
    }
  }

  async function synthesizeAndStreamTTS(text) {
    try {
      console.log("Sintetizando TTS:", text);
      ttsCancel = false;
      const ttsRespFormat = (audioFormat === "g711_ulaw") ? "wav" : "mp3";
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: VOICE,
          response_format: ttsRespFormat
        })
      });
      if (!res.ok) {
        console.error("Error en TTS:", res.statusText);
        return;
      }
      let audioBuffer = Buffer.from(await res.arrayBuffer());
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
          event: "media",
          streamSid: streamSid,
          media: { payload: chunk.toString("base64") }
        }));
        await new Promise((res) => setTimeout(res, 200));
      }
      botSpeaking = false;
    } catch (err) {
      console.error("Error en TTS:", err);
    }
  }

  // Funciones auxiliares para conversión de audio
  function convertG711UlawToWav16k(ulawBuffer) {
    const pcm8k = new Int16Array(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcm8k[i] = ulawToLinear(ulawBuffer[i]);
    }
    const pcm16k = resamplePCM(pcm8k, 8000, 16000);
    const header = createWavHeader(pcm16k.length, 16000, 1, 16);
    return Buffer.concat([header, Buffer.from(pcm16k.buffer)]);
  }
  function ulawToLinear(uByte) {
    uByte = ~uByte;
    const sign = uByte & 0x80;
    const exponent = (uByte >> 4) & 0x07;
    const mantissa = uByte & 0x0F;
    let sample = (mantissa << 4) + 8;
    sample <<= exponent;
    sample -= 132;
    return sign ? -sample : sample;
  }
  function convertWavToG711Ulaw(wavBuffer) {
    const headerSize = 44;
    const { sampleRate } = parseWavHeader(wavBuffer);
    const pcmData = wavBuffer.slice(headerSize);
    let inputPCM = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
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
  function createWavHeader(numSamples, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = numSamples * blockAlign;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return header;
  }
}

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
