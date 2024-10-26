// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const fastify = Fastify();
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;

// Ruta para la conexión WebSocket de prueba
fastify.register(async (fastify) => {
    fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente conectado al WebSocket');
        
        // Enviar un mensaje de bienvenida al cliente cuando se conecte
        connection.socket.send("Bienvenido al servidor WebSocket");

        // Evento cuando el cliente se desconecta
        connection.socket.on('close', () => {
            console.log('Cliente desconectado del WebSocket');
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Error al iniciar el servidor:', err);
        process.exit(1);
    }
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
