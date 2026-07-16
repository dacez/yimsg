package service

import (
	"errors"
	"log"
	"strconv"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/auth"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/service/taskpb"
	"yimsg/server/internal/shard"

	"google.golang.org/protobuf/proto"
)

// 组织域：org_info（组织字典）+ tag_info（tag/部门字典）+ org_relation（唯一同步域）。
//
// 成员资格是 contacts 的组织行（type=org, id=org_id），走既有通讯录同步；
// 组织关系表是独立同步域（org_id 路由），变更后经 taskqueue 向全体在线成员
// 扇出 org:updated 轻通知。

// taskKindOrgUpdated 是组织架构变更通知扇出任务 kind。
const taskKindOrgUpdated = "org_updated"

// taskKindOrgDeleted 是整个组织删除后、成员通讯录组织行异步清理任务 kind。
const taskKindOrgDeleted = "org_deleted"

var (
	errOrgCycle       = errors.New("org tag link would create a cycle")
	errOrgRootAsChild = errors.New("org root tag cannot be linked as a child")
)

// handleOrgUpdatedTask 是 org_updated 任务执行体：向全体在线成员推送轻通知。
// 通知只带 org_id、不带增量数据；离线成员靠上线后的增量同步追平，不补发。
func (s *AppState) handleOrgUpdatedTask(payload []byte) error {
	var task taskpb.OrgUpdatedTask
	if err := proto.Unmarshal(payload, &task); err != nil {
		log.Printf("org updated task unmarshal err=%v", err)
		return nil // 丢弃损坏载荷，避免每次启动无限重放
	}
	uids, err := s.OrgStore(task.GetOrgId()).ActiveMemberUIDs(task.GetOrgId())
	if err != nil {
		return err
	}
	for _, uid := range uids {
		s.Online().Notify(uid, appmsg.OrgUpdatedNotif(task.GetOrgId())())
	}
	return nil
}

// submitOrgUpdated 投递一条 org:updated 扇出任务（一次管理操作只投一条，天然合并成批变更）。
func (s *AppState) submitOrgUpdated(orgID int64) {
	s.submitTask(taskKindOrgUpdated, &taskpb.OrgUpdatedTask{OrgId: orgID})
}

// handleOrgDeletedTask 是 org_deleted 任务执行体：逐个成员软删除其通讯录组织行
// 并推送 contacts:updated（离职语义，与 RemoveOrgMemberDirect 的末边分支一致）。
func (s *AppState) handleOrgDeletedTask(payload []byte) error {
	var task taskpb.OrgDeletedTask
	if err := proto.Unmarshal(payload, &task); err != nil {
		log.Printf("org deleted task unmarshal err=%v", err)
		return nil // 丢弃损坏载荷，避免每次启动无限重放
	}
	for _, uid := range task.GetMemberUids() {
		if _, _, err := s.ContactStore(uid).Delete(uid, 0, 0, task.GetOrgId()); err != nil {
			log.Printf("org deleted contact delete uid=%d org=%d err=%v", uid, task.GetOrgId(), err)
			continue
		}
		notifyContactsUpdated(s, uid)
	}
	return nil
}

// submitOrgDeleted 投递一条组织删除后的成员通讯录清理任务。
func (s *AppState) submitOrgDeleted(orgID int64, memberUIDs []int64) {
	s.submitTask(taskKindOrgDeleted, &taskpb.OrgDeletedTask{OrgId: orgID, MemberUids: memberUIDs})
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

// requireOrgManage 校验调用方对 tagID 为根的子树有管理权限（GRANT 边覆盖
// tagID 或其祖先，见 OrgStore.CanManage）。组织管理面写 action 的统一入口；
// 身份取自帧头解析后的 BaseInfo.uid，不信任 body。
func requireOrgManage(s *AppState, reqID uint64, uid, orgID, tagID int64) *appmsg.Response {
	if orgID == 0 || tagID == 0 {
		return appmsg.ErrInvalidArgument(reqID, "org_id/tag_id required")
	}
	ok, err := s.OrgStore(orgID).CanManage(orgID, tagID, uid)
	if err != nil {
		return appmsg.ErrInternal(reqID, err.Error())
	}
	if !ok {
		return appmsg.ErrForbidden(reqID, "not authorized to manage this org node")
	}
	return nil
}

// orgWriteErr 把组织写路径的业务错误（防环、根不为子）映射为 ERROR_INVALID_ARGUMENT；
// 其余未识别错误按内部错误处理。
func orgWriteErr(reqID uint64, err error) *appmsg.Response {
	if errors.Is(err, errOrgCycle) || errors.Is(err, errOrgRootAsChild) {
		return appmsg.ErrInvalidArgument(reqID, err.Error())
	}
	return appmsg.ErrInternal(reqID, err.Error())
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
		orgs[i] = appmsg.OrgInfo{OrgID: o.OrgID, Name: o.Name, Avatar: o.Avatar}
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
		tags[i] = appmsg.TagInfo{TagID: t.TagID, Name: t.Name, Avatar: t.Avatar}
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
		TagID:     r.TagID,
		ChildID:   r.ChildID,
		ChildType: r.ChildType,
		Title:     r.Title,
		Rank:      r.Rank,
		SortKey:   r.SortKey,
		Status:    r.Status,
		Seq:       r.Seq,
	}
}

// ---- 组织建制写路径（Direct 后缀：不做权限校验的底层写原语，供协议层
// requireOrgManage 校验通过后调用，也供管理工具 / seed / 测试装配直接调用）----
//
// org 分片内 org_relation 行变更逐行 bump seq；每次操作提交后投递一条
// org:updated 扇出任务。org_relation 与 contacts 组织行跨分片双写、无事务，
// 沿用好友双写的容忍规则，兜底方向是"以 contacts 为门"。

// CreateOrgDirect 建组织：写 org_info 字典行，并把 initialAdminUID 设为组织根的
// 初始管理员（GRANT 边，挂在 tag_id=org_id 上）。这是权限链条唯一的自举点，
// 任何登录用户都可以调用（见协议层 CreateOrg），调用方自动成为根管理员。
// 返回新组织 ID。
func (s *AppState) CreateOrgDirect(name, avatar string, initialAdminUID int64) (int64, error) {
	orgID := s.IDGen().NextID()
	now := auth.NowMs()
	if err := s.OrgStore(orgID).UpsertOrgInfo(orgID, name, avatar, now); err != nil {
		return 0, err
	}
	if err := s.GrantOrgAdminDirect(orgID, orgID, initialAdminUID); err != nil {
		return 0, err
	}
	return orgID, nil
}

// DeleteOrgDirect 删除整个组织：先快照全体在职成员（结构删除后组织分片查不到
// "谁曾是成员"，必须先取），物理清空组织结构（tags/tag_info/org_info/
// org_version 同事务）。用快照直接通知在线成员——不走 submitOrgUpdated，因为
// 那条异步任务执行时会再查一次 ActiveMemberUIDs，届时组织结构已经删空，查不到
// 任何人。成员通讯录组织行清理（跨分片、容忍延迟）仍走异步任务，与既有群消息
// 扇出同构。
func (s *AppState) DeleteOrgDirect(orgID int64) error {
	memberUIDs, err := s.OrgStore(orgID).ActiveMemberUIDs(orgID)
	if err != nil {
		return err
	}
	if err := s.OrgStore(orgID).DeleteOrg(orgID); err != nil {
		return err
	}
	notif := appmsg.OrgUpdatedNotif(orgID)()
	for _, uid := range memberUIDs {
		s.Online().Notify(uid, notif)
	}
	s.submitOrgDeleted(orgID, memberUIDs)
	return nil
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
		dal.ContactSortKey("", childName), now)
	return err
}

// LinkOrgTagDirect 把已存在的 tag 额外挂到另一个父 tag 下（DAG 多父）。
func (s *AppState) LinkOrgTagDirect(orgID, parentTagID, childTagID, rank int64) error {
	if err := s.linkOrgTag(orgID, parentTagID, childTagID, rank, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// AddOrgMemberDirect 把人挂进 tag：写边 + 首边时联动通讯录组织行并推送 contacts:updated。
func (s *AppState) AddOrgMemberDirect(orgID, tagID, uid int64, title string, rank int64) error {
	now := auth.NowMs()
	nickname := userNickname(s, uid)
	store := s.OrgStore(orgID)
	_, hadActive, err := store.UpsertTag(orgID, tagID, uid, dal.TagChildPerson, title, rank,
		dal.ContactSortKey("", nickname), now)
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

// RemoveOrgMemberDirect 把人摘出 tag：墓碑边 + 末边时软删除通讯录组织行（离职）。
func (s *AppState) RemoveOrgMemberDirect(orgID, tagID, uid int64) error {
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

// RenameOrgDirect 改组织展示名/头像（组织字典，无级联；无边引用组织根，不涉及 sort_key 刷新）。
func (s *AppState) RenameOrgDirect(orgID int64, name, avatar string) error {
	if err := s.OrgStore(orgID).UpsertOrgInfo(orgID, name, avatar, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// RenameOrgTagDirect 改 tag 名；被挂边的 sort_key 级联在 DAL 同事务内完成。
func (s *AppState) RenameOrgTagDirect(orgID, tagID int64, name, avatar string) error {
	if err := s.OrgStore(orgID).RenameTagInfo(orgID, tagID, name, avatar, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// DeleteOrgTagDirect 墓碑 tag 及其两个方向的关联边（含挂在其上的管理员授权）；
// 受影响成员若因此失去全部边则联动离职。
func (s *AppState) DeleteOrgTagDirect(orgID, tagID int64) error {
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

// SetOrgItemRankDirect 调整一条边的排序/职务（人条目传 uid+TagChildPerson、
// tag 条目传 childTagID+TagChildTag）。
func (s *AppState) SetOrgItemRankDirect(orgID, tagID, childID int64, childType uint8, title string, rank int64) error {
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
	if _, _, err := store.UpsertTag(orgID, tagID, childID, childType, title, rank, sortKey, auth.NowMs()); err != nil {
		return err
	}
	s.submitOrgUpdated(orgID)
	return nil
}

// GrantOrgAdminDirect 授予 uid 管理 scopeTagID 为根子树的权限（写一条 GRANT 边）。
// GRANT 边不进入 get_tags/sync_tags 的展示与同步域，因此不投递 org:updated，
// 避免向全体成员扇出一次对他们不可见的空变更。
func (s *AppState) GrantOrgAdminDirect(orgID, scopeTagID, uid int64) error {
	_, _, err := s.OrgStore(orgID).UpsertTag(orgID, scopeTagID, uid, dal.TagChildGrant, "",
		dal.TagRankUnset, "", auth.NowMs())
	return err
}

// RevokeOrgAdminDirect 撤销 uid 对 scopeTagID 为根子树的管理权限；scopeTagID
// 为组织根时校验并保证组织至少保留一个根管理员（见 dal.ErrOrgLastRootAdmin）。
func (s *AppState) RevokeOrgAdminDirect(orgID, scopeTagID, uid int64) error {
	_, err := s.OrgStore(orgID).RevokeOrgAdmin(orgID, scopeTagID, uid, auth.NowMs())
	return err
}

// ---- 组织管理面协议 action：统一先 requireOrgManage 校验调用方对目标节点
// （或其祖先）持有管理员授权，再调用对应 Direct 写原语。----

// rankOrUnset 把可选 rank 指针转换为落库值：未传（nil）落 TagRankUnset（未显式
// 排序，按名字沉底），显式传 0 也是合法排序值，不能与"未传"混淆，因此这三个
// 写 action 的 rank 字段在协议里用 proto3 optional 声明为指针，不能用 GetRank()
// （nil 时同样返回 0，无法区分）。
func rankOrUnset(p *int64) int64 {
	if p == nil {
		return dal.TagRankUnset
	}
	return *p
}

// CreateOrg 建组织：任意登录用户都可以调用，是权限链条唯一的自举点，
// 不走 requireOrgManage（调用时组织还不存在，无节点可校验）。调用方
// 自动成为新组织根的初始管理员。
func (s *AppState) CreateOrg(info *BaseInfo, req *pb.CreateOrgRequest) *pb.CreateOrgResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, err := s.CreateOrgDirect(req.GetName(), req.GetAvatar(), uid)
	if err != nil {
		return toCreateOrgResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toCreateOrgResponse(appmsg.OKOrgCreated(reqID, orgID))
}

// DeleteOrg 删除整个组织：需对组织根持有管理权限。结构（tags/tag_info/
// org_info/org_version）同步清空；成员通讯录组织行异步清理（见 DeleteOrgDirect）。
func (s *AppState) DeleteOrg(info *BaseInfo, req *pb.DeleteOrgRequest) *pb.DeleteOrgResponse {
	reqID, uid := info.RequestID, info.UID
	orgID := req.GetOrgId()
	if resp := requireOrgManage(s, reqID, uid, orgID, orgID); resp != nil {
		return toDeleteOrgResponse(resp)
	}
	if err := s.DeleteOrgDirect(orgID); err != nil {
		return toDeleteOrgResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toDeleteOrgResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) CreateOrgTag(info *BaseInfo, req *pb.CreateOrgTagRequest) *pb.CreateOrgTagResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, parentTagID := req.GetOrgId(), req.GetParentTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, parentTagID); resp != nil {
		return toCreateOrgTagResponse(resp)
	}
	tagID, err := s.AddOrgTag(orgID, parentTagID, req.GetName(), req.GetAvatar(), rankOrUnset(req.Rank))
	if err != nil {
		return toCreateOrgTagResponse(orgWriteErr(reqID, err))
	}
	return toCreateOrgTagResponse(appmsg.OKOrgTagCreated(reqID, tagID))
}

func (s *AppState) RenameOrgTag(info *BaseInfo, req *pb.RenameOrgTagRequest) *pb.RenameOrgTagResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, tagID := req.GetOrgId(), req.GetTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, tagID); resp != nil {
		return toRenameOrgTagResponse(resp)
	}
	if err := s.RenameOrgTagDirect(orgID, tagID, req.GetName(), req.GetAvatar()); err != nil {
		return toRenameOrgTagResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toRenameOrgTagResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) DeleteOrgTag(info *BaseInfo, req *pb.DeleteOrgTagRequest) *pb.DeleteOrgTagResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, tagID := req.GetOrgId(), req.GetTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, tagID); resp != nil {
		return toDeleteOrgTagResponse(resp)
	}
	if err := s.DeleteOrgTagDirect(orgID, tagID); err != nil {
		return toDeleteOrgTagResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toDeleteOrgTagResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) LinkOrgTag(info *BaseInfo, req *pb.LinkOrgTagRequest) *pb.LinkOrgTagResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, parentTagID := req.GetOrgId(), req.GetParentTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, parentTagID); resp != nil {
		return toLinkOrgTagResponse(resp)
	}
	if err := s.LinkOrgTagDirect(orgID, parentTagID, req.GetChildTagId(), rankOrUnset(req.Rank)); err != nil {
		return toLinkOrgTagResponse(orgWriteErr(reqID, err))
	}
	return toLinkOrgTagResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) AddOrgMember(info *BaseInfo, req *pb.AddOrgMemberRequest) *pb.AddOrgMemberResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, tagID := req.GetOrgId(), req.GetTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, tagID); resp != nil {
		return toAddOrgMemberResponse(resp)
	}
	if err := s.AddOrgMemberDirect(orgID, tagID, req.GetUid(), req.GetTitle(), rankOrUnset(req.Rank)); err != nil {
		return toAddOrgMemberResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toAddOrgMemberResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) RemoveOrgMember(info *BaseInfo, req *pb.RemoveOrgMemberRequest) *pb.RemoveOrgMemberResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, tagID := req.GetOrgId(), req.GetTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, tagID); resp != nil {
		return toRemoveOrgMemberResponse(resp)
	}
	if err := s.RemoveOrgMemberDirect(orgID, tagID, req.GetUid()); err != nil {
		return toRemoveOrgMemberResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toRemoveOrgMemberResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) SetOrgItemRank(info *BaseInfo, req *pb.SetOrgItemRankRequest) *pb.SetOrgItemRankResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, tagID := req.GetOrgId(), req.GetTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, tagID); resp != nil {
		return toSetOrgItemRankResponse(resp)
	}
	childType := uint8(req.GetChildType())
	if childType != dal.TagChildPerson && childType != dal.TagChildTag {
		return toSetOrgItemRankResponse(appmsg.ErrInvalidArgument(reqID, "child_type must be PERSON or TAG"))
	}
	if err := s.SetOrgItemRankDirect(orgID, tagID, req.GetChildId(), childType, req.GetTitle(), req.GetRank()); err != nil {
		return toSetOrgItemRankResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toSetOrgItemRankResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) RenameOrg(info *BaseInfo, req *pb.RenameOrgRequest) *pb.RenameOrgResponse {
	reqID, uid := info.RequestID, info.UID
	orgID := req.GetOrgId()
	if resp := requireOrgManage(s, reqID, uid, orgID, orgID); resp != nil {
		return toRenameOrgResponse(resp)
	}
	if err := s.RenameOrgDirect(orgID, req.GetName(), req.GetAvatar()); err != nil {
		return toRenameOrgResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toRenameOrgResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) GrantOrgAdmin(info *BaseInfo, req *pb.GrantOrgAdminRequest) *pb.GrantOrgAdminResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, scopeTagID := req.GetOrgId(), req.GetScopeTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, scopeTagID); resp != nil {
		return toGrantOrgAdminResponse(resp)
	}
	if err := s.GrantOrgAdminDirect(orgID, scopeTagID, req.GetUid()); err != nil {
		return toGrantOrgAdminResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toGrantOrgAdminResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) RevokeOrgAdmin(info *BaseInfo, req *pb.RevokeOrgAdminRequest) *pb.RevokeOrgAdminResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, scopeTagID := req.GetOrgId(), req.GetScopeTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, scopeTagID); resp != nil {
		return toRevokeOrgAdminResponse(resp)
	}
	if err := s.RevokeOrgAdminDirect(orgID, scopeTagID, req.GetUid()); err != nil {
		if errors.Is(err, dal.ErrOrgLastRootAdmin) {
			return toRevokeOrgAdminResponse(appmsg.ErrConflict(reqID, err.Error()))
		}
		return toRevokeOrgAdminResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toRevokeOrgAdminResponse(appmsg.OKEmpty(reqID))
}

// ListOrgAdmins 列出直接挂在 scopeTagID 上的管理员（不含挂在祖先节点、递归覆盖到此的管理员）。
// 权限校验复用 requireOrgManage：只有对这个节点本就有管理权限的人才能看到管理员名单，
// 避免向普通成员泄露组织的管理结构。
func (s *AppState) ListOrgAdmins(info *BaseInfo, req *pb.ListOrgAdminsRequest) *pb.ListOrgAdminsResponse {
	reqID, uid := info.RequestID, info.UID
	orgID, scopeTagID := req.GetOrgId(), req.GetScopeTagId()
	if resp := requireOrgManage(s, reqID, uid, orgID, scopeTagID); resp != nil {
		return toListOrgAdminsResponse(resp)
	}
	uids, err := s.OrgStore(orgID).ListGrantedAdmins(orgID, scopeTagID)
	if err != nil {
		return toListOrgAdminsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toListOrgAdminsResponse(appmsg.OKOrgAdmins(reqID, uids))
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
