package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

var reqID atomic.Int64

func nextReqID() string {
	return fmt.Sprintf("%d", reqID.Add(1))
}

func send(conn *websocket.Conn, msg map[string]interface{}) (map[string]interface{}, error) {
	id := nextReqID()
	msg["request_id"] = id

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("read: %w", err)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, fmt.Errorf("unmarshal: %w", err)
		}
		// Skip notifications (no request_id or different request_id)
		if rid, ok := resp["request_id"]; ok && fmt.Sprintf("%v", rid) == id {
			if ok, _ := resp["ok"].(bool); !ok {
				return resp, fmt.Errorf("server error: %v", resp["error"])
			}
			return resp, nil
		}
		// else it's a notification or different response, skip
	}
}

func main() {
	conn, _, err := websocket.DefaultDialer.Dial("ws://localhost:8080/ws", nil)
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// 1. Login as User1
	fmt.Println("=== Logging in as User1 ===")
	resp, err := send(conn, map[string]interface{}{
		"action":   "login",
		"username": "User1",
		"password": "123456",
	})
	if err != nil {
		log.Fatalf("login: %v", err)
	}
	fmt.Printf("Login OK, data: %v\n\n", resp["data"])

	// 2. fetch_conversations
	fmt.Println("=== fetch_conversations (limit=5) ===")
	resp, err = send(conn, map[string]interface{}{
		"action": "fetch_conversations",
		"limit":  5,
	})
	if err != nil {
		log.Fatalf("fetch_conversations: %v", err)
	}

	data, _ := resp["data"].(map[string]interface{})
	convs, _ := data["conversations"].([]interface{})

	// Find first group conversation (group_id != "0")
	var groupID string
	var convKey string
	for _, c := range convs {
		conv, _ := c.(map[string]interface{})
		gid := fmt.Sprintf("%v", conv["group_id"])
		fmt.Printf("  conv: peer_uid=%v group_id=%v seq=%v\n",
			conv["peer_uid"], conv["group_id"], conv["seq"])
		if gid != "0" && gid != "" && groupID == "" {
			groupID = gid
			convKey = gid
		}
	}

	if groupID == "" {
		log.Fatal("No group conversation found")
	}
	fmt.Printf("\nUsing group_id=%s for comparison\n\n", groupID)

	// 3. fetch_conversation_messages for the group
	fmt.Println("=== Lite mode (fetch_conversation_messages) ===")
	resp, err = send(conn, map[string]interface{}{
		"action":   "fetch_conversation_messages",
		"group_id": json.Number(groupID),
		"limit":    10,
	})
	if err != nil {
		log.Fatalf("fetch_conversation_messages: %v", err)
	}

	data, _ = resp["data"].(map[string]interface{})
	liteMessages, _ := data["messages"].([]interface{})

	fmt.Printf("Got %d messages:\n", len(liteMessages))
	for i, m := range liteMessages {
		msg, _ := m.(map[string]interface{})
		fmt.Printf("  [%d] seq=%v content=%v\n", i, msg["seq"], msg["content"])
	}

	// 4. sync_messages with last_seq=0, limit=5000
	fmt.Println("\n=== sync_messages (last_seq=0, limit=5000) ===")
	resp, err = send(conn, map[string]interface{}{
		"action":   "sync_messages",
		"last_seq": 0,
		"limit":    5000,
	})
	if err != nil {
		log.Fatalf("sync_messages: %v", err)
	}

	data, _ = resp["data"].(map[string]interface{})
	allMessages, _ := data["messages"].([]interface{})
	fmt.Printf("Total synced messages: %d\n", len(allMessages))

	// 5. Filter by group_id (conv_key)
	var filtered []map[string]interface{}
	for _, m := range allMessages {
		msg, _ := m.(map[string]interface{})
		gid := fmt.Sprintf("%v", msg["group_id"])
		if gid == convKey {
			filtered = append(filtered, msg)
		}
	}
	fmt.Printf("Filtered to group_id=%s: %d messages\n", convKey, len(filtered))

	// 6. Take the LAST 10 (most recent, simulating DESC query)
	start := 0
	if len(filtered) > 10 {
		start = len(filtered) - 10
	}
	persistentMessages := filtered[start:]

	fmt.Println("\n=== Persistent mode (sync -> filter by conv_key) ===")
	fmt.Printf("Got %d messages (last 10):\n", len(persistentMessages))
	for i, msg := range persistentMessages {
		fmt.Printf("  [%d] seq=%v content=%v\n", i, msg["seq"], msg["content"])
	}

	// 7. Comparison
	fmt.Println("\n=== Comparison ===")

	// Build seq lists for comparison
	liteSeqs := make([]string, len(liteMessages))
	for i, m := range liteMessages {
		msg, _ := m.(map[string]interface{})
		liteSeqs[i] = fmt.Sprintf("%v", msg["seq"])
	}

	persistentSeqs := make([]string, len(persistentMessages))
	for i, msg := range persistentMessages {
		persistentSeqs[i] = fmt.Sprintf("%v", msg["seq"])
	}

	fmt.Printf("Lite seqs: %v\n", liteSeqs)
	fmt.Printf("Persistent seqs: %v\n", persistentSeqs)

	match := len(liteSeqs) == len(persistentSeqs)
	if match {
		for i := range liteSeqs {
			if liteSeqs[i] != persistentSeqs[i] {
				match = false
				break
			}
		}
	}

	if match {
		fmt.Println("MATCH: Both modes return the same messages.")
	} else {
		fmt.Println("DIFFER: The two modes return different messages!")
		fmt.Printf("  Lite count: %d, Persistent count: %d\n", len(liteSeqs), len(persistentSeqs))
	}
}
