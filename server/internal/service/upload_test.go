package service

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func uploadRequest(t *testing.T, s *AppState, token, category, filename string, content []byte) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if category != "" {
		w.WriteField("category", category)
	}
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	part.Write(content)
	w.Close()

	req := httptest.NewRequest("POST", "/api/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	handler := Upload(s)
	handler(rec, req)
	return rec.Result()
}

func parseUploadResp(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	body, _ := io.ReadAll(resp.Body)
	var m map[string]any
	json.Unmarshal(body, &m)
	return m
}

func TestUploadMissingAuth(t *testing.T) {
	s := testState(t)
	resp := uploadRequest(t, s, "", "image", "test.png", []byte("data"))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

func TestUploadInvalidToken(t *testing.T) {
	s := testState(t)
	resp := uploadRequest(t, s, "invalid-token", "image", "test.png", []byte("data"))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

func TestUploadInvalidCategory(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "unknown", "test.png", []byte("data"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
	m := parseUploadResp(t, resp)
	if !strings.Contains(m["error"].(string), "invalid category") {
		t.Errorf("error = %q", m["error"])
	}
}

func TestUploadAvatarBadExtension(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "avatar", "test.exe", []byte("data"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestUploadImageBadExtension(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "image", "test.bmp", []byte("data"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestUploadAvatarSuccess(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "avatar", "photo.png", []byte("pngdata"))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	m := parseUploadResp(t, resp)
	if m["ok"] != true {
		t.Error("expected ok=true")
	}
	url, _ := m["url"].(string)
	if !strings.HasPrefix(url, "/media/avatar/") {
		t.Errorf("url = %q, should start with /media/avatar/", url)
	}
}

func TestUploadImageSuccess(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "image", "photo.jpg", []byte("jpgdata"))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	m := parseUploadResp(t, resp)
	url, _ := m["url"].(string)
	if !strings.HasPrefix(url, "/media/image/") {
		t.Errorf("url = %q, should start with /media/image/", url)
	}
}

func TestUploadFileSuccess(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	resp := uploadRequest(t, s, token, "file", "doc.pdf", []byte("pdfdata"))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	m := parseUploadResp(t, resp)
	url, _ := m["url"].(string)
	if !strings.HasPrefix(url, "/media/file/") {
		t.Errorf("url = %q, should start with /media/file/", url)
	}
}

func TestUploadFileAnyExtension(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	// File category accepts any extension
	resp := uploadRequest(t, s, token, "file", "data.xyz", []byte("data"))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("file category should accept any extension, got status %d", resp.StatusCode)
	}
}

func TestUploadNoExtension(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "p", "Alice")

	// Avatar without extension should fail
	resp := uploadRequest(t, s, token, "avatar", "noext", []byte("data"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("avatar without extension should fail, got status %d", resp.StatusCode)
	}
}
