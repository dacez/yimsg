package service

import "yimsg/server/internal/appmsg"

func rejectTooOldSyncSeq(reqID uint64, lastSeq, gcSafeSeq int64, rebuild bool) *appmsg.Response {
	if !rebuild && lastSeq < gcSafeSeq {
		return appmsg.ErrSeqTooOld(reqID)
	}
	return nil
}
