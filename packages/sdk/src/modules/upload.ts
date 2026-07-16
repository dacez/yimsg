import type { UploadCategory, UploadResult } from '../types';
import { PreconditionError, RequestError } from '../errors';

interface ServerUploadResponse {
  ok: boolean;
  media_id?: string;
  url?: string;
  size?: number;
  error?: string;
}

export async function uploadFile(file: File, category: UploadCategory, token: string, uploadUrl = '/api/upload'): Promise<UploadResult> {
  if (!token) {
    throw new PreconditionError('AUTH_REQUIRED', 'uploadFile 需要先完成登录');
  }
  const formData = new FormData();
  formData.append('file', file);
  formData.append('category', category);
  const resp = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  if (!resp.ok) {
    throw new RequestError('UPLOAD_FAILED', `upload failed: HTTP ${resp.status}`);
  }
  const body: ServerUploadResponse = await resp.json();
  if (!body.ok) {
    throw new RequestError('UPLOAD_FAILED', body.error || 'upload failed');
  }
  return { mediaId: String(body.media_id || ''), url: body.url!, size: body.size };
}
