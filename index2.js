<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chat en Tiempo Real con Estefanía</title>
</head>
<body>
    <h1>Bienvenido al chat con Estefanía</h1>
    <button id="startButton">Iniciar Chat</button>
    <audio id="audioPlayback" autoplay></audio>

    <script>
        let audioContext, mediaRecorder, ws;

        document.getElementById("startButton").onclick = async () => {
            // Initialize WebSocket
            ws = new WebSocket("wss://realtimelyc-f2b32a7bc8c5.herokuapp.com/web-media-stream");

            ws.onopen = () => {
                console.log("Connected to the WebSocket server.");
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.event === "media") {
                    const audioElement = document.getElementById("audioPlayback");
                    audioElement.src = `data:audio/webm;base64,${data.media.payload}`;
                }
            };

            // Initialize audio capture
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        ws.send(JSON.stringify({
                            event: 'media',
                            media: { payload: reader.result.split(',')[1] }
                        }));
                    };
                    reader.readAsDataURL(event.data);
                }
            };

            mediaRecorder.start(1000);
        };

        ws.onclose = () => {
            console.log("Disconnected from WebSocket server.");
            mediaRecorder.stop();
        };
    </script>
</body>
</html>
