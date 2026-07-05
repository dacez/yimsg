package service

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"yimsg/internal/appmsg"
	"yimsg/internal/protocol/pb"
)

var avatarExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true}
var imageExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true}

// Upload handles file uploads via HTTP POST /api/upload.
func Upload(s *AppState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, http.StatusMethodNotAllowed, appmsg.ErrorCodeInvalidArgument, "method not allowed")
			return
		}

		// Auth via Bearer token
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, http.StatusUnauthorized, appmsg.ErrorCodeAuthRequired, "missing token")
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")

		resp := s.Authenticate(&BaseInfo{}, &pb.AuthenticateRequest{Token: token})
		if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
			writeErrorJSON(w, http.StatusUnauthorized, appmsg.ErrorCodeAuthFailed, "invalid token")
			return
		}

		// Parse multipart
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "invalid multipart form")
			return
		}

		category := r.FormValue("category")
		if category == "" {
			category = "file"
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "missing file")
			return
		}
		defer file.Close()

		ext := strings.ToLower(filepath.Ext(header.Filename))
		size := header.Size

		// Validate
		switch category {
		case "avatar":
			if !avatarExts[ext] {
				writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "unsupported file format")
				return
			}
			if s.Config().Media.MaxAvatarBytes > 0 && size > s.Config().Media.MaxAvatarBytes {
				writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "avatar too large")
				return
			}
		case "image":
			if !imageExts[ext] {
				writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "unsupported file format")
				return
			}
			if s.Config().Media.MaxImageBytes > 0 && size > s.Config().Media.MaxImageBytes {
				writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "image too large")
				return
			}
		case "file":
			if s.Config().Media.MaxFileBytes > 0 && size > s.Config().Media.MaxFileBytes {
				writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "file too large")
				return
			}
		default:
			writeErrorJSON(w, http.StatusBadRequest, appmsg.ErrorCodeInvalidArgument, "invalid category")
			return
		}

		// Generate filename and save
		fileID := s.IDGen().NextID()
		filename := fmt.Sprintf("%d%s", fileID, ext)
		dir := filepath.Join(s.Config().Media.UploadDir, category)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Printf("upload mkdir err: %v", err)
			writeErrorJSON(w, http.StatusInternalServerError, appmsg.ErrorCodeInternal, "server error")
			return
		}

		dst, err := os.Create(filepath.Join(dir, filename))
		if err != nil {
			log.Printf("upload create err: %v", err)
			writeErrorJSON(w, http.StatusInternalServerError, appmsg.ErrorCodeInternal, "server error")
			return
		}
		defer dst.Close()

		n, err := io.Copy(dst, file)
		if err != nil {
			log.Printf("upload copy err: %v", err)
			writeErrorJSON(w, http.StatusInternalServerError, appmsg.ErrorCodeInternal, "server error")
			return
		}

		// 媒体只用 id 引用：消息 body 仅保存 media_id，展示地址由客户端按
		// /media/{category}/{media_id} 约定还原。url 仅为头像等仍按 URL 引用的场景保留。
		url := fmt.Sprintf("/media/%s/%s", category, filename)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"media_id": strconv.FormatInt(fileID, 10),
			"url":      url,
			"size":     n,
		})
	}
}

// MediaHandler 服务 /media/ 下的媒体文件。
//   - 带扩展名（如 /media/avatar/123.png）：直接按文件名读取。
//   - 不带扩展名（如 /media/image/123）：按 media_id 解析 <id>.* 文件，
//     使消息 body 只需保存 media_id 即可还原媒体地址。
func MediaHandler(uploadDir string) http.HandlerFunc {
	fileServer := http.StripPrefix("/media/", http.FileServer(http.Dir(uploadDir)))
	return func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/media/")
		if rel == "" || strings.Contains(rel, "..") {
			http.NotFound(w, r)
			return
		}
		full := filepath.Join(uploadDir, filepath.Clean(rel))
		if !strings.HasPrefix(full, filepath.Clean(uploadDir)+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		if filepath.Ext(rel) == "" {
			matches, _ := filepath.Glob(full + ".*")
			if len(matches) > 0 {
				http.ServeFile(w, r, matches[0])
				return
			}
		}
		http.NotFound(w, r)
	}
}

func writeErrorJSON(w http.ResponseWriter, status int, errorCode, errMsg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": errMsg, "error_code": errorCode})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
