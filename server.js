const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.on('join-room', (roomId) => {
        if (socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(roomId);
        socket.currentRoom = roomId;
    });

    socket.on('new-user', (name) => {
        socket.userName = name;
        socket.to(socket.currentRoom).emit('chat-message', { user: 'SYSTEM', text: `${name} joined the room` });
    });

    socket.on('draw', (data) => {
        socket.to(socket.currentRoom).emit('draw', data);
    });


    socket.on('chat-message', (data) => {
        socket.to(socket.currentRoom).emit('chat-message', data);
    });

    socket.on('sync-state', (dataURL) => {
        socket.to(socket.currentRoom).emit('sync-state', dataURL);
    });

    socket.on('clear', () => socket.to(socket.currentRoom).emit('clear'));

    socket.on('disconnect', () => {
    });
});

http.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT || 3000}`));