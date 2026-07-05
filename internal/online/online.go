// Package online manages the in-memory registry of online users and their WebSocket connections.
package online

import (
	"sync"
	"sync/atomic"
	"yimsg/internal/appmsg"
)

var nextID atomic.Int64

// Conn represents a registered connection with a unique ID and a send channel.
type Conn struct {
	ID    int64
	Token string
	Ch    chan *appmsg.Notification
}

// newConn creates a new Conn with a buffered channel.
func newConn(token string) *Conn {
	return &Conn{
		ID:    nextID.Add(1),
		Token: token,
		Ch:    make(chan *appmsg.Notification, 64),
	}
}

// Registry tracks online users and their notification channels.
type Registry struct {
	mu    sync.RWMutex
	users map[int64][]*Conn
}

// New creates a new online user registry.
func New() *Registry {
	return &Registry{users: make(map[int64][]*Conn)}
}

// Register adds a connection for a user and returns the Conn.
// The caller should read from Conn.Ch in a goroutine to receive notifications.
// The channel is closed when Unregister is called.
func (r *Registry) Register(uid int64, token string) *Conn {
	c := newConn(token)
	r.mu.Lock()
	r.users[uid] = append(r.users[uid], c)
	r.mu.Unlock()
	return c
}

// Unregister removes a specific connection and closes its channel.
// After this call, the Conn.Ch range loop will exit.
func (r *Registry) Unregister(uid int64, c *Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	conns := r.users[uid]
	for i, conn := range conns {
		if conn.ID == c.ID {
			r.users[uid] = append(conns[:i], conns[i+1:]...)
			close(c.Ch)
			break
		}
	}
	if len(r.users[uid]) == 0 {
		delete(r.users, uid)
	}
}

// Notify sends a message to all connections of a user.
// Holds RLock during sends to prevent race with Unregister closing channels.
// Sends are non-blocking (buffered channel with select/default).
func (r *Registry) Notify(uid int64, msg *appmsg.Notification) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, c := range r.users[uid] {
		select {
		case c.Ch <- msg:
		default:
		}
	}
}

// NotifyExceptToken sends a message to all connections of a user except those with the given token.
func (r *Registry) NotifyExceptToken(uid int64, excludeToken string, msg *appmsg.Notification) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, c := range r.users[uid] {
		if c.Token == excludeToken {
			continue
		}
		select {
		case c.Ch <- msg:
		default:
		}
	}
}

// NotifyMany sends a message to all connections of multiple users.
func (r *Registry) NotifyMany(uids []int64, msg *appmsg.Notification) {
	for _, uid := range uids {
		r.Notify(uid, msg)
	}
}
