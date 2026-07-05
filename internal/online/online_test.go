package online

import (
	"testing"
	"time"
	"yimsg/internal/appmsg"
)

func TestRegisterAndNotify(t *testing.T) {
	r := New()
	c := r.Register(1, "")

	notif := appmsg.ContactsUpdatedNotif()
	r.Notify(1, notif)

	select {
	case msg := <-c.Ch:
		if msg != notif {
			t.Fatalf("unexpected msg: %#v", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for notification")
	}
}

func TestUnregisterClosesChannel(t *testing.T) {
	r := New()
	c := r.Register(1, "")
	r.Unregister(1, c)

	// Channel should be closed — reading returns zero value and false
	msg, ok := <-c.Ch
	if ok {
		t.Fatalf("channel should be closed, got msg=%#v", msg)
	}
}

func TestNotifyAfterUnregisterNoPanic(t *testing.T) {
	r := New()
	c := r.Register(1, "")
	r.Unregister(1, c)

	// Should not panic — user is removed from registry
	r.Notify(1, appmsg.ContactsUpdatedNotif())
}

func TestMultipleConnections(t *testing.T) {
	r := New()
	c1 := r.Register(1, "")
	c2 := r.Register(1, "")

	notif := appmsg.ContactsUpdatedNotif()
	r.Notify(1, notif)

	for _, c := range []*Conn{c1, c2} {
		select {
		case msg := <-c.Ch:
			if msg != notif {
				t.Fatalf("unexpected: %#v", msg)
			}
		case <-time.After(time.Second):
			t.Fatal("timeout")
		}
	}
}

func TestNotifyMany(t *testing.T) {
	r := New()
	c1 := r.Register(1, "")
	c2 := r.Register(2, "")

	notif := appmsg.ContactsUpdatedNotif()
	r.NotifyMany([]int64{1, 2}, notif)

	for _, c := range []*Conn{c1, c2} {
		select {
		case msg := <-c.Ch:
			if msg != notif {
				t.Fatalf("unexpected: %#v", msg)
			}
		case <-time.After(time.Second):
			t.Fatal("timeout")
		}
	}
}

func TestNotifyNonexistentUser(t *testing.T) {
	r := New()
	r.Notify(999, appmsg.ContactsUpdatedNotif()) // should not panic
}

func TestUnregisterCleanup(t *testing.T) {
	r := New()
	c := r.Register(1, "")
	r.Unregister(1, c)

	r.mu.RLock()
	_, exists := r.users[1]
	r.mu.RUnlock()

	if exists {
		t.Fatal("user entry should be cleaned up after last unregister")
	}
}

func TestPartialUnregister(t *testing.T) {
	r := New()
	c1 := r.Register(1, "")
	c2 := r.Register(1, "")
	r.Unregister(1, c1)

	// c1 channel is closed
	_, ok := <-c1.Ch
	if ok {
		t.Fatal("c1 channel should be closed")
	}

	notif := appmsg.ContactsUpdatedNotif()
	r.Notify(1, notif)

	select {
	case msg := <-c2.Ch:
		if msg != notif {
			t.Fatalf("unexpected: %#v", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("c2 should receive")
	}
}

func TestChannelRangeExitsOnClose(t *testing.T) {
	r := New()
	c := r.Register(1, "")

	// Simulate the notification reader goroutine pattern from ws/connection.go
	done := make(chan struct{})
	var received []*appmsg.Notification
	go func() {
		for msg := range c.Ch {
			received = append(received, msg)
		}
		close(done)
	}()

	r.Notify(1, appmsg.ContactsUpdatedNotif())
	r.Notify(1, appmsg.BlocklistUpdatedNotif())
	time.Sleep(50 * time.Millisecond) // let goroutine process

	r.Unregister(1, c)

	select {
	case <-done:
		// goroutine exited — success
	case <-time.After(time.Second):
		t.Fatal("goroutine did not exit after channel closed")
	}

	if len(received) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(received))
	}
}
