package e2e

import (
	"crypto/tls"
	"io"
	"net/http"
	"testing"
	"time"
)

// minimalPNG is a valid 1x1 pixel PNG image.
var minimalPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
	0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
	0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
	0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
	0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
	0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
	0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
	0x44, 0xAE, 0x42, 0x60, 0x82,
}

func TestUploadImage(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("upload"), "pass1234", "Uploader")

	resp := uploadFile(t, c.token, "image", "test.png", minimalPNG)
	if !resp.OK {
		t.Fatalf("upload image failed: %s", resp.Error)
	}
	if resp.URL == "" {
		t.Fatal("upload should return url")
	}
	if resp.Size == nil || *resp.Size <= 0 {
		t.Fatal("upload should return positive size")
	}
}

func TestUploadAvatar(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("upload"), "pass1234", "Uploader")

	resp := uploadFile(t, c.token, "avatar", "avatar.png", minimalPNG)
	if !resp.OK {
		t.Fatalf("upload avatar failed: %s", resp.Error)
	}
	if resp.URL == "" {
		t.Fatal("upload should return url")
	}
	if resp.Size == nil || *resp.Size <= 0 {
		t.Fatal("upload should return positive size")
	}
}

func TestUploadFile(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("upload"), "pass1234", "Uploader")

	content := []byte("hello world, this is a test file")
	resp := uploadFile(t, c.token, "file", "readme.txt", content)
	if !resp.OK {
		t.Fatalf("upload file failed: %s", resp.Error)
	}
	if resp.URL == "" {
		t.Fatal("upload should return url")
	}
	if resp.Size == nil || *resp.Size != int64(len(content)) {
		t.Fatalf("upload size mismatch: got %v, want %d", resp.Size, len(content))
	}
}

func TestUploadNoAuth(t *testing.T) {
	resp := uploadFile(t, "invalid_token_xyz", "image", "test.png", minimalPNG)
	if resp.OK {
		t.Fatal("upload without valid auth should fail")
	}
}

func TestUploadInvalidCategory(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("upload"), "pass1234", "Uploader")

	resp := uploadFile(t, c.token, "videos", "test.mp4", []byte("fake video"))
	if resp.OK {
		t.Fatal("upload with invalid category should fail")
	}
}

func TestUploadedFileAccessible(t *testing.T) {
	c := dial(t)
	c.registerAndLogin(uniqueName("upload"), "pass1234", "Uploader")

	resp := uploadFile(t, c.token, "image", "access.png", minimalPNG)
	if !resp.OK {
		t.Fatalf("upload failed: %s", resp.Error)
	}

	// HTTP GET the uploaded file
	fileURL := httpBaseURL + resp.URL
	httpClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	getResp, err := httpClient.Get(fileURL)
	if err != nil {
		t.Fatalf("GET %s: %v", fileURL, err)
	}
	defer getResp.Body.Close()

	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status = %d, want 200", fileURL, getResp.StatusCode)
	}

	body, _ := io.ReadAll(getResp.Body)
	if len(body) == 0 {
		t.Fatal("downloaded file should not be empty")
	}
}

func TestImageMessage(t *testing.T) {
	// 上传图片后用 ImageBody（仅 media_id 引用）发送图片消息。
	sender := dial(t)
	sender.registerAndLogin(uniqueName("upload"), "pass1234", "Sender")
	receiver := dial(t)
	receiver.registerAndLogin(uniqueName("upload"), "pass1234", "Receiver")
	makeFriends(t, sender, receiver)
	sender.drainNotifs(func(n notification) bool { return true })
	receiver.drainNotifs(func(n notification) bool { return true })

	upResp := uploadFile(t, sender.token, "image", "photo.png", minimalPNG)
	if !upResp.OK {
		t.Fatalf("upload failed: %s", upResp.Error)
	}
	if upResp.MediaID == "" {
		t.Fatal("upload should return media_id")
	}

	// 媒体可按 /media/image/{media_id}（无扩展名）解析访问。
	assertMediaAccessible(t, "/media/image/"+upResp.MediaID)

	sendResp := sender.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   receiver.uid,
		"msg_type": 2, // MESSAGE_TYPE_IMAGE
		"body":     map[string]any{"image": map[string]any{"media_id": upResp.MediaID, "mime": "image/png", "caption": "photo"}},
	})
	if sendResp.MsgID == "" {
		t.Fatal("send_message should return msg_id")
	}

	receiver.waitNotif(func(n notification) bool { return n.Type == "messages:received" }, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	syncResp := receiver.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0, "limit": 100})
	found := false
	for _, msg := range syncResp.Messages {
		if msg.MsgID == sendResp.MsgID {
			if msg.MsgType != 2 {
				t.Errorf("msg_type = %d, want 2", msg.MsgType)
			}
			if msg.Body.Image == nil || msg.Body.Image.MediaID != upResp.MediaID {
				t.Errorf("image body media_id mismatch: %+v", msg.Body.Image)
			}
			found = true
			break
		}
	}
	if !found {
		t.Fatal("receiver should see the image message after sync")
	}
}

func TestFileMessage(t *testing.T) {
	sender := dial(t)
	sender.registerAndLogin(uniqueName("upload"), "pass1234", "Sender")
	receiver := dial(t)
	receiver.registerAndLogin(uniqueName("upload"), "pass1234", "Receiver")
	makeFriends(t, sender, receiver)
	sender.drainNotifs(func(n notification) bool { return true })
	receiver.drainNotifs(func(n notification) bool { return true })

	fileContent := []byte("important document content here")
	upResp := uploadFile(t, sender.token, "file", "doc.txt", fileContent)
	if !upResp.OK {
		t.Fatalf("upload failed: %s", upResp.Error)
	}
	if upResp.MediaID == "" {
		t.Fatal("upload should return media_id")
	}

	sendResp := sender.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   receiver.uid,
		"msg_type": 4, // MESSAGE_TYPE_FILE
		"body":     map[string]any{"file": map[string]any{"media_id": upResp.MediaID, "name": "doc.txt", "size": len(fileContent)}},
	})
	if sendResp.MsgID == "" {
		t.Fatal("send_message should return msg_id")
	}

	receiver.waitNotif(func(n notification) bool { return n.Type == "messages:received" }, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	syncResp := receiver.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0, "limit": 100})
	found := false
	for _, msg := range syncResp.Messages {
		if msg.MsgID == sendResp.MsgID {
			if msg.MsgType != 4 {
				t.Errorf("msg_type = %d, want 4", msg.MsgType)
			}
			if msg.Body.File == nil || msg.Body.File.MediaID != upResp.MediaID || msg.Body.File.Name != "doc.txt" {
				t.Errorf("file body mismatch: %+v", msg.Body.File)
			}
			found = true
			break
		}
	}
	if !found {
		t.Fatal("receiver should see the file message after sync")
	}
}

func assertMediaAccessible(t *testing.T, path string) {
	t.Helper()
	httpClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	getResp, err := httpClient.Get(httpBaseURL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status = %d, want 200", path, getResp.StatusCode)
	}
}
