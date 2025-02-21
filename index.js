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

// Almacenamos el contexto de cada llamada en memoria, indexado por CallSid.
const sessions = {};

/**
 * Endpoint para la llamada entrante.
 * Se crea la sesión y se responde con TwiML usando <Gather input="speech">.
 */
fastify.post('/incoming-call', async (req, reply) => {
  const callSid = req.body.CallSid || 'default';
  sessions[callSid] = {
    context: [
      {
        role: 'system',
        content:
          'Sos Gastón. Atención al cliente de Molinos Rio de la Plata. Sos argentino, hablás bien como un porteño, con acentuación y tonalidad característica. Decí "tenés" en lugar de "tienes" y "acá" en vez de "aquí".'
      }
    ]
  };

  // TwiML que reproduce un mensaje y usa <Gather> para capturar la voz del usuario.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/process-speech" method="POST" speechTimeout="auto">
    <Say voice="alice">Hola, ¿en qué puedo ayudarte hoy?</Say>
  </Gather>
  <Say voice="alice">No recibí respuesta.</Say>
  <Redirect>/incoming-call</Redirect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

/**
 * Endpoint para procesar la entrada de voz.
 * Twilio envía el resultado del reconocimiento (SpeechResult).
 * Se agrega al contexto, se consulta GPT, y se responde con TwiML que reproduce el audio TTS.
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
  // Guardamos la respuesta para la síntesis TTS
  sessions[callSid].lastResponse = botResponse;
  console.log(`Call ${callSid} - GPT responde: ${botResponse}`);

  // Generamos TwiML que reproduce el audio TTS obtenido de nuestro endpoint /tts y vuelve a iniciar el Gather.
  // Notar que usamos la URL completa, basándonos en el host de la petición.
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${protocol}://${req.headers.host}/tts?callSid=${callSid}</Play>
  <Gather input="speech" action="/process-speech" method="POST" speechTimeout="auto">
    <Say voice="alice">Si necesitas algo más, decime.</Say>
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
 * Función que consulta la API de Chat de OpenAI (GPT-4)
 * usando el contexto de la conversación.
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
