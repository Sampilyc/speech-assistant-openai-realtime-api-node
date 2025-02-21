// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch'; // Usamos node-fetch para llamar a las APIs
import { Buffer, Blob } from 'buffer'; // Node 18 ya incluye Blob y Buffer

// Cargar variables de entorno
dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Falta la clave API de OpenAI. Por favor, establécela en las variables de entorno.');
  process.exit(1);
}

const PORT = process.env.PORT || 5050;

// Mensajes del sistema para cada modalidad
const SYSTEM_MESSAGE = `Sos Gastón. Atención al cliente de la empresa Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, tanto en forma de hablar, acentuación y tonalidad. Enfatizá que los argentinos no decimos "tienes", decimos "tenés", no decimos "aquí", decimos "acá", y aplicá eso para todos los casos similares (por ejemplo, en vez de "tendrás" decís "tenés"). El acento porteño también pronuncia la "ll" como una "sh" (por ejemplo, "llovió" suena como "shovió", similar a "Shazam" o "Sheila"). Tené en cuenta esto en todos los casos. Sos simpático y servicial y no hables con tono monótono, para que no parezcas un robot; poné énfasis como una persona real y hablá rápido. Estás al teléfono con un cliente que acaba de llamar. No te salgas de tu rol ni de la temática. Indagá sobre qué quiere el cliente antes de proceder a cargar el reclamo: es muy importante que hagas preguntas suficientes para obtener más información y armar un relato detallado de lo que expresa el cliente (en lo que respecta al reclamo o la queja; no te quedes con lo primero que te diga, indagá más). Luego, una vez que tengas completo lo que el cliente quiere (reclamo o sugerencia) y según corresponda, cargalo en la categoría correspondiente (pidiéndole los datos que correspondan para la categoría establecida). Pedile los datos de a uno o dos a la vez, todos juntos, para no atascar al cliente. No pidas ningún dato antes de haber repreguntado y obtenido el comentario completo (reclamo o sugerencia). Finalmente, cuando se complete el reclamo, indicale al cliente que le llegará un correo electrónico y despidiéndote.`;

const SYSTEM_MESSAGE_WEB = `Sos Gastón, la asistente virtual de Molinos Rio de la Plata. Atendés al usuario que chatea contigo desde la web.`;

// La voz a usar para TTS (se asume que la API de síntesis de OpenAI acepta este parámetro)
const VOICE = 'echo';

// Inicializar Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Ruta raíz (verifica que el servidor esté corriendo)
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
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
  Función que configura el manejo del WebSocket para la transmisión de media.
  Se usa tanto para Twilio (/media-stream, audio en g711_ulaw) como para la web (/web-media-stream, audio en webm_opus).
  La lógica:
   - Se acumulan los chunks de audio recibidos.
   - Se reinicia un timer de silencio; al caducar, se procesa el audio acumulado:
       • Si es g711_ulaw se convierte a WAV (para que Whisper lo procese).
       • Se llama a la API de transcripción (Whisper) para obtener el texto.
       • Se agrega el mensaje del usuario al contexto y se consulta GPT (Chat API) para obtener la respuesta.
       • Con la respuesta se llama a la API de síntesis (TTS) para obtener audio y se lo transmite en chunks.
   - Si durante la reproducción TTS llega audio del usuario, se interrumpe (cancelación) y se procesa el nuevo input.
*/
function setupMediaStreamHandler(connection, audioFormat) {
  let streamSid = null;
  let conversationContext = [];
  let userAudioChunks = [];
  let silenceTimer = null;
  let botSpeaking = false;
  let ttsCancel = false;
  const SILENCE_THRESHOLD = 700; // milisegundos sin audio para considerar que terminó el habla

  // Selecciona el mensaje del sistema según la modalidad (Twilio o web)
  const systemMsg = audioFormat === 'g711_ulaw' ? SYSTEM_MESSAGE : SYSTEM_MESSAGE_WEB;
  conversationContext.push({ role: 'system', content: systemMsg });

  // Al iniciar la conexión simulamos que el usuario dice "Hola" para que el bot inicie la conversación.
  processUserUtterance("Hola!");

  // Reinicia el timer de silencio cada vez que llega audio.
  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (userAudioChunks.length > 0) {
        processUserAudio();
      }
    }, SILENCE_THRESHOLD);
  }

  // Manejo de mensajes entrantes
  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log("Stream iniciado:", streamSid);
        return;
      }
      if (data.event === 'media') {
        // Si el bot está reproduciendo audio y llega audio del usuario, se interrumpe la reproducción.
        if (botSpeaking) {
          console.log("Interrupción detectada: el usuario habló mientras el bot hablaba");
          ttsCancel = true;
        }
        // Acumular el chunk de audio (convertir de base64 a Buffer)
        const chunkBuffer = Buffer.from(data.media.payload, 'base64');
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

  // Procesa el audio acumulado del usuario
  async function processUserAudio() {
    const audioBuffer = Buffer.concat(userAudioChunks);
    userAudioChunks = [];
    let wavBuffer;
    if (audioFormat === 'g711_ulaw') {
      wavBuffer = convertG711UlawToWav(audioBuffer);
    } else {
      // Para web, se asume que el formato (webm_opus) es aceptable para Whisper; de lo contrario, habría que convertirlo.
      wavBuffer = audioBuffer;
    }
    console.log("Procesando audio del usuario, longitud (bytes):", wavBuffer.length);

    // Llamada a la API Whisper para transcribir el audio
    const transcription = await transcribeAudio(wavBuffer);
    if (!transcription) {
      console.error("Error en la transcripción.");
      return;
    }
    console.log("Transcripción:", transcription);
    // Agregar mensaje del usuario al contexto y obtener respuesta del bot
    conversationContext.push({ role: 'user', content: transcription });
    const botResponse = await getGPTResponse(conversationContext);
    if (!botResponse) {
      console.error("Error en la respuesta de GPT.");
      return;
    }
    conversationContext.push({ role: 'assistant', content: botResponse });
    await synthesizeAndStreamTTS(botResponse);
  }

  // Procesa un mensaje de usuario dado (por ejemplo, el "Hola" inicial)
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

  // Llama a la API de chat de OpenAI (GPT-4) para obtener la respuesta en base al contexto.
  async function getGPTResponse(messages) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4", // o el identificador que uses (por ejemplo, "gpt-4o")
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
      // Se utiliza FormData (disponible en Node 18)
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.wav');
      formData.append('model', 'whisper-1');
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`
          // No se setea Content-Type para que FormData lo configure automáticamente
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

  // Llama a la API de síntesis de voz (TTS) de OpenAI para generar audio a partir del texto y lo envía en chunks.
  async function synthesizeAndStreamTTS(text) {
    try {
      console.log("Sintetizando TTS para el texto:", text);
      ttsCancel = false;
      const response = await fetch("https://api.openai.com/v1/audio/synthesis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          voice: VOICE,
          text: text,
          output_audio_format: audioFormat  // "g711_ulaw" o "webm_opus" según corresponda
        })
      });
      if (!response.ok) {
        console.error("Error en la API TTS:", response.statusText);
        return;
      }
      // Se asume que la respuesta es JSON con { audio: "base64string" }
      const data = await response.json();
      let audioData = Buffer.from(data.audio, 'base64');
      console.log("Audio TTS recibido, longitud (bytes):", audioData.length);
      botSpeaking = true;
      const chunkSize = 1600; // Ajustar según la duración del chunk (por ejemplo, 200ms de audio en g711)
      for (let i = 0; i < audioData.length; i += chunkSize) {
        if (ttsCancel) {
          console.log("Reproducción TTS interrumpida por el usuario.");
          break;
        }
        const chunk = audioData.slice(i, i + chunkSize);
        connection.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        // Esperar el tiempo correspondiente al chunk (por ejemplo, 200ms)
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      botSpeaking = false;
    } catch (error) {
      console.error("Error en la síntesis TTS:", error);
    }
  }

  // --- Funciones de conversión de audio ---

  // Convierte un Buffer de audio en g711_ulaw a un Buffer WAV (PCM lineal a 8kHz, mono, 16 bits)
  function convertG711UlawToWav(ulawBuffer) {
    // Decodifica cada byte de u-law a una muestra PCM de 16 bits
    const pcmSamples = new Int16Array(ulawBuffer.length);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcmSamples[i] = ulawToLinear(ulawBuffer[i]);
    }
    const wavHeader = createWavHeader(pcmSamples.length, 8000, 1, 16);
    const pcmBuffer = Buffer.from(pcmSamples.buffer);
    return Buffer.concat([wavHeader, pcmBuffer]);
  }

  // Función de conversión de μ-law a PCM lineal (16 bits)
  function ulawToLinear(ulawByte) {
    // Conversión basada en el algoritmo estándar
    ulawByte = ~ulawByte;
    const sign = ulawByte & 0x80;
    const exponent = (ulawByte >> 4) & 0x07;
    const mantissa = ulawByte & 0x0F;
    let sample = (mantissa << 4) + 0x08;
    sample = sample << exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
  }

  // Crea un header WAV para datos PCM
  function createWavHeader(numSamples, sampleRate, numChannels, bitsPerSample) {
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = numSamples * numChannels * bitsPerSample / 8;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0); // ChunkID
    buffer.writeUInt32LE(36 + dataSize, 4); // ChunkSize
    buffer.write('WAVE', 8); // Format
    buffer.write('fmt ', 12); // Subchunk1ID
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
    buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36); // Subchunk2ID
    buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size
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

// Registrar endpoint para web (audio en webm_opus)
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
