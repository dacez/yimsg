package service

import "yimsg/protocol/generated/go/pb"

func targetIDs(target *pb.ConversationTarget) (int64, int64) {
	if target == nil {
		return 0, 0
	}
	return target.GetUid(), target.GetGroupId()
}

func contactTargetIDs(target *pb.ContactTarget) (friendUID, groupID, orgID int64) {
	if target == nil {
		return 0, 0, 0
	}
	return target.GetUid(), target.GetGroupId(), target.GetOrgId()
}
