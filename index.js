import Fastify from 'fastify';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fastifyFormBody from '@fastify/formbody';

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Falta la clave API de OpenAI.");
  process.exit(1);
}

const PORT = process.env.PORT || 5050;
const fastify = Fastify();
fastify.register(fastifyFormBody);

// Usamos un objeto en memoria para guardar el contexto de cada llamada, indexado por CallSid.
const sessions = {};

/**
 * Endpoint para atender la llamada entrante.
 * Inicializa el contexto y responde con TwiML que reproduce un audio inicial y
 * utiliza <Gather input="speech" bargeIn="true"> para captar la voz del usuario.
 */
fastify.post('/incoming-call', async (req, reply) => {
  const callSid = req.body.CallSid || 'default';
  sessions[callSid] = {
    context: [
      { role: 'system', content: 'Sos Gastón. Atención al cliente de Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, con acentuación y tonalidad característica. Decí "tenés" en lugar de "tienes" y "acá" en vez de "aquí".' }
    ]
  };

  // TwiML: reproducir audio inicial (mp3) y luego iniciar <Gather> con reconocimiento nativo de Twilio.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://www.logicoycreativo.com/heroku/bienvenidamolinos.mp3</Play>
  <Gather input="speech" bargeIn="true" action="/process-speech" method="POST" speechTimeout="auto">
    <Say voice="alice">Hola, ¿en qué puedo ayudarte hoy?</Say>
  </Gather>
  <Say voice="alice">No he recibido respuesta.</Say>
  <Redirect>/incoming-call</Redirect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

/**
 * Endpoint para procesar la entrada de voz del usuario.
 * Twilio envía el resultado del reconocimiento (SpeechResult).
 * Se agrega al contexto, se consulta GPT-4 y se almacena la respuesta.
 * Luego se genera TwiML que reproduce el audio TTS (generado con OpenAI)
 * mediante <Play> y vuelve a iniciar un Gather para continuar la conversación.
 */
fastify.post('/process-speech', async (req, reply) => {
  const callSid = req.body.CallSid || 'default';
  const speechResult = req.body.SpeechResult || '';
  if (!sessions[callSid]) {
    sessions[callSid] = { context: [] };
  }
  sessions[callSid].context.push({ role: 'user', content: speechResult });
  console.log(`Call ${callSid} - Usuario dijo: ${speechResult}`);

  const botResponse = await getGPTResponse(sessions[callSid].context);
  sessions[callSid].context.push({ role: 'assistant', content: botResponse });
  sessions[callSid].lastResponse = botResponse;
  console.log(`Call ${callSid} - GPT responde: ${botResponse}`);

  // Usamos la URL completa para el endpoint de TTS, basándonos en el host de la petición.
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${protocol}://${req.headers.host}/tts?callSid=${callSid}</Play>
  <Gather input="speech" bargeIn="true" action="/process-speech" method="POST" speechTimeout="auto">
    <Say voice="alice">Si necesitas algo más, por favor decime.</Say>
  </Gather>
  <Redirect>/incoming-call</Redirect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

/**
 * Endpoint que genera el audio TTS usando OpenAI.
 * Llama a la API de OpenAI TTS y retorna el audio en formato mp3.
 */
fastify.get('/tts', async (req, reply) => {
  const callSid = req.query.callSid || 'default';
  if (!sessions[callSid] || !sessions[callSid].lastResponse) {
    reply.code(404).send('No hay respuesta para sintetizar.');
    return;
  }
  const text = sessions[callSid].lastResponse;
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: "echo",
        response_format: "mp3"
      })
    });
    if (!response.ok) {
      reply.code(500).send("Error en la síntesis de voz.");
      return;
    }
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    reply.header("Content-Type", "audio/mpeg");
    reply.send(audioBuffer);
  } catch (err) {
    console.error(err);
    reply.code(500).send("Error procesando TTS.");
  }
});

/**
 * Función que consulta la API de Chat de OpenAI (GPT-4) usando el contexto.
 */
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
      return "Lo siento, no entendí tu consulta.";
    }
  } catch (error) {
    console.error("Error llamando a la API de GPT:", error);
    return "Lo siento, hubo un error procesando tu consulta.";
  }
}

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error al iniciar el servidor:", err);
    process.exit(1);
  }
  console.log(`Servidor escuchando en ${address}`);
});
