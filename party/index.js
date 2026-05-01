export default class GameServer {
  constructor(room) {
    this.room    = room;
    this.players = new Map(); // connectionId -> player state
  }

  onConnect(conn) {
    // Tell the new player their own ID
    conn.send(JSON.stringify({ type: 'welcome', id: conn.id }));

    // Send them the current state of everyone already in the room
    const players = Object.fromEntries(this.players);
    conn.send(JSON.stringify({ type: 'init', players }));
  }

  onMessage(message, sender) {
    try {
      const data = JSON.parse(message);
      if (data.type !== 'update') return;
      this.players.set(sender.id, data.state);
      this.room.broadcast(
        JSON.stringify({ type: 'update', id: sender.id, state: data.state }),
        [sender.id] // exclude the sender
      );
    } catch (_) {}
  }

  onClose(conn) {
    this.players.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: 'leave', id: conn.id }));
  }
}
