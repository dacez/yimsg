package service

import (
	"encoding/json"
	"errors"
	"log"
	"strconv"

	"yimsg/internal/appmsg"
	"yimsg/internal/auth"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/shard"
)

// 组织域：org_info（组织字典）+ tag_info（tag/部门字典）+ org_relation（唯一同步域）。
//
// 成员资格是 contacts 的组织行（type=org, id=org_id），走既有通讯录同步；
// 组织关系表是独立同步域（org_id 路由），变更后经 taskqueue 向全体在线成员
// 扇出 org:updated 轻通知。

// taskKindOrgUpdated 是组织架构变更通知扇出任务 kind。
const taskKindOrgUpdated = "org_updated"

var (
	errOrgCycle       = errors.New("org tag link would create a cycle")
	errOrgRootAsChild = errors.New("org root tag cannot be linked as a child")
)

// orgUpdatedTask 是 org:updated 扇出任务载荷（JSON 持久化）。
type orgUpdatedTask struct {
	OrgID int64 `json:"org_id"`
}

// handleOrgUpdatedTask 是 org_updated 任务执行体：向全体在线成员推送轻通知。
// 通知只带 org_id、不带增量数据；离线成员靠上线后的增量同步追平，不补发。
func (s *AppState) handleOrgUpdatedTask(payload []byte) error {
	var task orgUpdatedTask
	if err := json.Unmarshal(payload, &task); err != nil {
		log.Printf("org updated task unmarshal err=%v", err)
		return nil // 丢弃损坏载荷，避免每次启动无限重放
	}
	uids, err := s.OrgStore(task.OrgID).ActiveMemberUIDs(task.OrgID)
	if err != nil {
		return err
	}
	for _, uid := range uids {
		s.Online().Notify(uid, appmsg.OrgUpdatedNotif(task.OrgID)())
	}
	return nil
}

// submitOrgUpdated 投递一条 org:updated 扇出任务（一次管理操作只投一条，天然合并成批变更）。
func (s *AppState) submitOrgUpdated(orgID int64) {
	s.submitTask(taskKindOrgUpdated, orgUpdatedTask{OrgID: orgID})
}

// orgName 读取组织展示名。
func orgName(s *AppState, orgID int64) string {
	info, err := s.OrgStore(orgID).GetOrgInfo(orgID)
	if err != nil || info == nil {
		return ""
	}
	return info.Name
}

// requireOrgMember 校验调用方是组织成员：点查调用方 uid 分片的通讯录组织行，O(1) 主键命中。
// 身份取自帧头解析后的 BaseInfo.uid，不信任 body。
func requireOrgMember(s *AppState, reqID uint64, uid, orgID int64) *appmsg.Response {
	if orgID == 0 {
		return appmsg.ErrInvalidArgument(reqID, "org_id required")
	}
	row, err := s.ContactStore(uid).GetByKey(uid, 0, 0, orgID)
	if err != nil {
		return appmsg.ErrInternal(reqID, err.Error())
	}
	if row == nil || row.Status != dal.ContactFriend {
		return appmsg.ErrForbidden(reqID, "not an org member")
	}
	return nil
}

// ---- 只读 action ----

func (s *AppState) GetOrgInfos(info *BaseInfo, req *pb.GetOrgInfosRequest) *pb.GetOrgInfosResponse {
	reqID := info.RequestID
	callerUID := info.UID
	orgIDs := req.GetOrgIds()
	if exceededBatch(orgIDs, s.MaxBatchLimit()) {
		return toGetOrgInfosResponse(errBatchLimit(reqID, s.MaxBatchLimit()))
	}
	infos, err := batchQueryShard(s.DB().OrgShards, orgIDs, func(db *shard.DB, batch []int64) ([]dal.OrgInfo, error) {
		return dal.NewOrgStore(db).ListOrgInfos(batch)
	})
	if err != nil {
		return toGetOrgInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// 与 get_group_infos 同构：拉展示资料时顺带刷新调用方通讯录组织行的排序/搜索投影。
	if callerUID != 0 && len(infos) > 0 {
		names := make(map[int64]string, len(infos))
		for _, o := range infos {
			names[o.OrgID] = o.Name
		}
		changed, err := s.ContactStore(callerUID).UpdateOrgProjections(callerUID, names, auth.NowMs())
		if err != nil {
			return toGetOrgInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		if changed > 0 {
			notifyContactsUpdated(s, callerUID)
		}
	}

	orgs := make([]appmsg.OrgInfo, len(infos))
	for i, o := range infos {
		orgs[i] = appmsg.OrgInfo{OrgID: appmsg.JSONInt64(o.OrgID), Name: o.Name, Avatar: o.Avatar}
	}
	return toGetOrgInfosResponse(appmsg.OKOrgInfos(reqID, orgs))
}

// GetTagInfos 批量读取本组织内 tag（部门/横向分组）的展示资料字典，仅组织成员可读。
func (s *AppState) GetTagInfos(info *BaseInfo, req *pb.GetTagInfosRequest) *pb.GetTagInfosResponse {
	reqID := info.RequestID
	uid := info.UID
	orgID := req.GetOrgId()
	if resp := requireOrgMember(s, reqID, uid, orgID); resp != nil {
		return toGetTagInfosResponse(resp)
	}
	tagIDs := req.GetTagIds()
	if exceededBatch(tagIDs, s.MaxBatchLimit()) {
		return toGetTagInfosResponse(errBatchLimit(reqID, s.MaxBatchLimit()))
	}
	rows, err := s.OrgStore(orgID).ListTagInfos(orgID, tagIDs)
	if err != nil {
		return toGetTagInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	tags := make([]appmsg.TagInfo, len(rows))
	for i, t := range rows {
		tags[i] = appmsg.TagInfo{TagID: appmsg.JSONInt64(t.TagID), Name: t.Name, Avatar: t.Avatar}
	}
	return toGetTagInfosResponse(appmsg.OKTagInfos(reqID, tags))
}

func (s *AppState) GetTags(info *BaseInfo, req *pb.GetTagsRequest) *pb.GetTagsResponse {
	reqID := info.RequestID
	uid := info.UID
	orgID := req.GetOrgId()
	tagID := req.GetTagId()
	if resp := requireOrgMember(s, reqID, uid, orgID); resp != nil {
		return toGetTagsResponse(resp)
	}
	if tagID == 0 {
		return toGetTagsResponse(appmsg.ErrInvalidArgument(reqID, "tag_id required; expand root with tag_id=org_id"))
	}
	store := s.OrgStore(orgID)
	if tagID != orgID { // 组织根天然存在，只校验非根 tag
		tag, err := store.GetTagInfo(orgID, tagID)
		if err != nil {
			return toGetTagsResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		if tag == nil {
			return toGetTagsResponse(appmsg.ErrNotFound(reqID, "tag not found"))
		}
	}

	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	parts, err := decodeCursor(page.cursor)
	if err != nil {
		return toGetTagsResponse(appmsg.ErrInvalidArgument(reqID, "invalid cursor"))
	}
	rows, err := store.ListTagsPage(orgID, tagID, parts, page.backward, page.limit+1)
	if err != nil {
		return toGetTagsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	hasMoreTraveled := int64(len(rows)) > page.limit
	if hasMoreTraveled {
		rows = rows[:page.limit]
	}
	if page.backward {
		reverseInPlace(rows) // ListTagsPage backward 返回反展示序，转回展示序
	}

	relations := make([]appmsg.Tag, len(rows))
	for i, row := range rows {
		relations[i] = tagFromDAL(row)
	}

	pi := appmsg.PageInfo{Total: -1}
	if len(rows) > 0 {
		pi.StartCursor = tagCursor(rows[0])
		pi.EndCursor = tagCursor(rows[len(rows)-1])
	}
	if page.backward {
		pi.HasMoreBackward = hasMoreTraveled
		pi.HasMoreForward = page.hasCursor
	} else {
		pi.HasMoreForward = hasMoreTraveled
		pi.HasMoreBackward = page.hasCursor
	}
	resp := appmsg.OKGetTags(reqID, relations)
	resp.Page = &pi
	return toGetTagsResponse(resp)
}

// tagCursor 按展示序编码关系条目的不透明 keyset 游标 [rank, sort_key, child_type, child_id]。
func tagCursor(r dal.Tag) string {
	return encodeCursor(
		strconv.FormatInt(r.Rank, 10),
		r.SortKey,
		strconv.FormatInt(int64(r.ChildType), 10),
		strconv.FormatInt(r.ChildID, 10),
	)
}

func (s *AppState) SyncTags(info *BaseInfo, req *pb.SyncTagsRequest) *pb.SyncTagsResponse {
	reqID := info.RequestID
	uid := info.UID
	orgID := req.GetOrgId()
	if resp := requireOrgMember(s, reqID, uid, orgID); resp != nil {
		return toSyncTagsResponse(resp)
	}
	afterSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	store := s.OrgStore(orgID)

	gcSafeSeq, _, err := store.GetVersion(orgID)
	if err != nil {
		return toSyncTagsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if resp := rejectTooOldSyncSeq(reqID, afterSeq, gcSafeSeq, req.GetRebuild()); resp != nil {
		return toSyncTagsResponse(resp)
	}

	rows, hasMore, err := store.SyncPage(orgID, afterSeq, limit)
	if err != nil {
		return toSyncTagsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	relations := make([]appmsg.Tag, len(rows))
	for i, row := range rows {
		relations[i] = tagFromDAL(row)
	}

	resp := appmsg.OKSyncTags(reqID, relations)
	seqs := make([]int64, 0, len(rows))
	for _, row := range rows {
		seqs = append(seqs, row.Seq)
	}
	setCursor(resp, seqs, true, hasMore)
	return toSyncTagsResponse(resp)
}

func tagFromDAL(r dal.Tag) appmsg.Tag {
	return appmsg.Tag{
		TagID:     appmsg.JSONInt64(r.TagID),
		ChildID:   appmsg.JSONInt64(r.ChildID),
		ChildType: r.ChildType,
		Title:     r.Title,
		Rank:      r.Rank,
		SortKey:   r.SortKey,
		Role:      r.Role,
		Status:    r.Status,
		Seq:       r.Seq,
	}
}

// ---- 组织建制写路径（管理工具 / seed / 测试装配使用，不上协议）----
//
// org 分片内 org_relation 行变更逐行 bump seq；每次操作提交后投递一条
// org:updated 扇出任务。org_relation 与 contacts 组织行跨分片双写、无事务，
// 沿用好友双写的容忍规则，兜底方向是"以 contacts 为门"。

// CreateOrg 建组织：写 org_info 字典行。返回新组织 ID。
func (s *AppState) CreateOrg(name, avatar string) (int64, error) {
	orgID := s.IDGen().NextID()
	if err := s.OrgStore(orgID).UpsertOrgInfo(orgID, name, avatar, auth.NowMs()); err != nil {
		return 0, err
	}
	s.submitOrgUpdated(orgID)
	return orgID, nil
}

// AddOrgTag 建 tag 字典行并挂到 parentTagID 下（防环 + 根不为子在此校验）。返回新 tag ID。
func (s *AppState) AddOrgTag(orgID, parentTagID int64, name, avatar string, rank int64) (int64, error) {
	tagID := s.IDGen().NextID()
	now := auth.NowMs()
	store := s.OrgStore(orgID)
	if err := store.UpsertTagInfo(orgID, tagID, name, avatar, now); err != nil {
		return 0, err
	}
	if err := s.linkOrgTag(orgID, parentTagID, tagID, rank, now); err != nil {
		return 0, err
	}
	s.submitOrgUpdated(orgID)
	return tagID, nil
}

// linkOrgTag 把已存在的 tag 挂到 parentTagID 下：防环 BFS + 根不为子校验。
func (s *AppState) linkOrgTag(orgID, parentTagID, childTagID, rank int64, now int64) error {
	if childTagID == orgID {
		return errOrgRootAsChild
	}
	store := s.OrgStore(orgID)
	cycle, err := store.WouldCreateCycle(orgID, parentTagID, childTagID)
	if err != nil {
		return err
	}
	if cycle {
		return errOrgCycle
	}
	child, err := store.GetTagInfo(orgID, childTagID)
	if err != nil {
		return err
	}
	childName := ""
	if child != nil {
		childName = child.Name
	}
	_, _, err = store.UpsertTag(orgID, parentTagID, childTagID, dal.TagChildTag, "", rank,
		dal.ContactSortKey("", childName), dal.TagRoleMember, now)
	return err
}

// LinkOrgTag 把已存在的 tag 额外挂到另一个父 tag 下（DAG 多父）。
func (s *AppState) LinkOrgTag(orgID, parentTagID, childTagID, rank int64) error {
	if err := s.linkOrgTag(orgID, parentTagID, childTagID, rank, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// AddOrgMember 把人挂进 tag：写边 + 首边时联动通讯录组织行并推送 contacts:updated。
// role 标识该成员在这个 tag 下是否为管理员。
func (s *AppState) AddOrgMember(orgID, tagID, uid int64, title string, rank int64, role uint8) error {
	now := auth.NowMs()
	nickname := userNickname(s, uid)
	store := s.OrgStore(orgID)
	_, hadActive, err := store.UpsertTag(orgID, tagID, uid, dal.TagChildPerson, title, rank,
		dal.ContactSortKey("", nickname), role, now)
	if err != nil {
		return err
	}
	if !hadActive {
		// 第一条边：入职，写通讯录组织行（跨分片双写，失败容忍，以 contacts 为门）。
		name := orgName(s, orgID)
		_, err := s.ContactStore(uid).Upsert(uid, 0, 0, orgID, dal.ContactFriend, "",
			dal.ContactSortKey("", name), dal.ContactSearchText("", name), now)
		if err != nil {
			log.Printf("org member contact upsert uid=%d org=%d err=%v", uid, orgID, err)
		}
		notifyContactsUpdated(s, uid)
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// RemoveOrgMember 把人摘出 tag：墓碑边 + 末边时软删除通讯录组织行（离职）。
func (s *AppState) RemoveOrgMember(orgID, tagID, uid int64) error {
	removed, stillActive, err := s.OrgStore(orgID).RemoveTag(orgID, tagID, uid, dal.TagChildPerson, auth.NowMs())
	if err != nil {
		return err
	}
	if !removed {
		return nil
	}
	if !stillActive {
		// 最后一条边：离职，软删除通讯录组织行（tombstone 走既有同步与 Contact GC）。
		if _, _, err := s.ContactStore(uid).Delete(uid, 0, 0, orgID); err != nil {
			log.Printf("org member contact delete uid=%d org=%d err=%v", uid, orgID, err)
		}
		notifyContactsUpdated(s, uid)
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// RenameOrg 改组织展示名/头像（组织字典，无级联；无边引用组织根，不涉及 sort_key 刷新）。
func (s *AppState) RenameOrg(orgID int64, name, avatar string) error {
	if err := s.OrgStore(orgID).UpsertOrgInfo(orgID, name, avatar, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// RenameOrgTag 改 tag 名；被挂边的 sort_key 级联在 DAL 同事务内完成。
func (s *AppState) RenameOrgTag(orgID, tagID int64, name, avatar string) error {
	if err := s.OrgStore(orgID).RenameTagInfo(orgID, tagID, name, avatar, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// DeleteOrgTag 墓碑 tag 及其两个方向的关联边；受影响成员若因此失去全部边则联动离职。
func (s *AppState) DeleteOrgTag(orgID, tagID int64) error {
	store := s.OrgStore(orgID)
	// 先取直属成员，删除后一次性比对剩余在职成员，差集即离职。
	direct, err := store.ListDirectMemberUIDs(orgID, tagID)
	if err != nil {
		return err
	}
	found, err := store.DeleteTagInfo(orgID, tagID, auth.NowMs())
	if err != nil || !found {
		return err
	}
	remaining, err := store.ActiveMemberUIDs(orgID)
	if err != nil {
		return err
	}
	remainSet := make(map[int64]struct{}, len(remaining))
	for _, uid := range remaining {
		remainSet[uid] = struct{}{}
	}
	for _, uid := range direct {
		if _, ok := remainSet[uid]; ok {
			continue
		}
		if _, _, err := s.ContactStore(uid).Delete(uid, 0, 0, orgID); err != nil {
			log.Printf("org member contact delete uid=%d org=%d err=%v", uid, orgID, err)
		}
		notifyContactsUpdated(s, uid)
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// SetOrgItemRank 调整一条边的排序/职务/角色（人条目传 uid+TagChildPerson、
// tag 条目传 childTagID+TagChildTag）。
func (s *AppState) SetOrgItemRank(orgID, tagID, childID int64, childType uint8, title string, rank int64, role uint8) error {
	store := s.OrgStore(orgID)
	var sortKey string
	if childType == dal.TagChildPerson {
		sortKey = dal.ContactSortKey("", userNickname(s, childID))
	} else {
		child, err := store.GetTagInfo(orgID, childID)
		if err != nil {
			return err
		}
		if child != nil {
			sortKey = dal.ContactSortKey("", child.Name)
		}
	}
	if _, _, err := store.UpsertTag(orgID, tagID, childID, childType, title, rank, sortKey, role, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// refreshOrgMemberProjections 在用户昵称变化后重算其所有组织内边的 sort_key 并扇出通知。
// 组织列表来自调用方自己分片的通讯录组织行；跨分片写沿用容忍规则。
func refreshOrgMemberProjections(s *AppState, uid int64, nickname string) {
	orgIDs, err := s.ContactStore(uid).ListOrgIDs(uid)
	if err != nil {
		log.Printf("list org ids uid=%d err=%v", uid, err)
		return
	}
	sortKey := dal.ContactSortKey("", nickname)
	now := auth.NowMs()
	for _, orgID := range orgIDs {
		changed, err := s.OrgStore(orgID).UpdateMemberSortKeys(orgID, uid, sortKey, now)
		if err != nil {
			log.Printf("refresh org member sort keys uid=%d org=%d err=%v", uid, orgID, err)
			continue
		}
		if changed > 0 {
			s.submitOrgUpdated(orgID)
		}
	}
}
