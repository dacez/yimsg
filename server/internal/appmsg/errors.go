package appmsg

import "yimsg/protocol/generated/go/pb"

const (
	ErrorCodeAlreadyExists      = "ALREADY_EXISTS"
	ErrorCodeAuthFailed         = "AUTH_FAILED"
	ErrorCodeAuthRequired       = "AUTH_REQUIRED"
	ErrorCodeBatchLimitExceeded = "BATCH_LIMIT_EXCEEDED"
	ErrorCodeConflict           = "CONFLICT"
	ErrorCodeForbidden          = "FORBIDDEN"
	ErrorCodeFrameTooLarge      = "FRAME_TOO_LARGE"
	ErrorCodeInternal           = "INTERNAL_ERROR"
	ErrorCodeInvalidArgument    = "INVALID_ARGUMENT"
	ErrorCodeInvalidFrame       = "INVALID_FRAME"
	ErrorCodeInvalidProtobuf    = "INVALID_PROTOBUF"
	ErrorCodeNotFound           = "NOT_FOUND"
	ErrorCodeSeqTooOld          = "SEQ_TOO_OLD"
	ErrorCodeUnknownAction      = "UNKNOWN_ACTION"
)

// ErrorCodeNumber 返回对外稳定错误码对应的 protobuf enum 数值。
func ErrorCodeNumber(code string) int64 {
	switch code {
	case ErrorCodeInvalidFrame:
		return 1002
	case ErrorCodeFrameTooLarge:
		return 1003
	case ErrorCodeInvalidProtobuf:
		return 1004
	case ErrorCodeAuthRequired:
		return 1101
	case ErrorCodeAuthFailed:
		return 1102
	case ErrorCodeUnknownAction:
		return 1201
	case ErrorCodeInvalidArgument:
		return 1301
	case ErrorCodeNotFound:
		return 1401
	case ErrorCodeAlreadyExists:
		return 1402
	case ErrorCodeConflict:
		return 1403
	case ErrorCodeForbidden:
		return 1404
	case ErrorCodeSeqTooOld:
		return 1501
	case ErrorCodeBatchLimitExceeded:
		return 1502
	case ErrorCodeInternal:
		return 9001
	default:
		return 9001
	}
}

// ErrorCodeToPb 返回对外稳定错误码对应的 pb.ErrorCode enum 值。
func ErrorCodeToPb(code string) pb.ErrorCode {
	return pb.ErrorCode(ErrorCodeNumber(code))
}
