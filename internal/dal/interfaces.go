package dal

// UserStoreAPI defines user read/write operations consumed by service layer.
type UserStoreAPI interface {
	Create(uid int64, username, passwordHash, nickname string, now int64) error
	Get(uid int64) (*User, error)
	GetInfo(uid int64) (*User, error)
	ListByUIDs(uids []int64) ([]User, error)
	UpdateProfile(uid int64, nickname, avatar string, now int64) (bool, error)
	UpdatePassword(uid int64, passwordHash string, now int64) (bool, error)
}

// UserLookupStoreAPI defines username -> uid mapping operations.
type UserLookupStoreAPI interface {
	Insert(username string, uid int64) (bool, error)
	Delete(username string) error
	GetUID(username string) (int64, error)
	ListAll(limit int64) (map[string]int64, error)
}

// SessionStoreAPI defines token-session operations.
type SessionStoreAPI interface {
	Create(token string, uid, createdAt, expireAt int64) error
	Get(token string) (*Session, error)
	Delete(token string) error
	DeleteByUID(uid int64) error
	Renew(token string, newExpireAt int64) error
	Purge(now, limit int64) (int64, error)
}

// UserSessionStoreAPI defines uid -> token index operations.
type UserSessionStoreAPI interface {
	AddToken(uid int64, token, device string, now int64) error
	RemoveToken(uid int64, token string) error
	ListTokens(uid int64) ([]UserSession, error)
	RemoveTokens(uid int64) error
	ListAll(limit int64) ([]int64, error)
}

// ContactStoreAPI defines contact operations.
type ContactStoreAPI interface {
	Upsert(uid, friendUID, groupID, orgID int64, status uint8, remarkName, sortKey, searchText string, now int64) (int64, error)
	Delete(uid, friendUID, groupID, orgID int64) (seq int64, ok bool, err error)
	AcceptRequest(uid, friendUID int64) (bool, error)
	RejectRequest(uid, friendUID int64) (bool, error)
	AcceptCounterpartRequest(uid, friendUID int64) (bool, error)
	RejectCounterpartRequest(uid, friendUID int64) (bool, error)
	UpdateRemark(uid, friendUID, groupID, orgID int64, remarkName, sortKey, searchText string, now int64) (bool, error)
	List(uid, limit int64) ([]Contact, error)
	ListPage(uid int64, filter ContactListFilter, cursorParts []string, backward bool, limit int64) ([]Contact, error)
	Count(uid int64, filter ContactListFilter) (int64, error)
	Purge(uid int64) (int64, error)
	ListPurgeable(limit, afterUID int64) ([]int64, error)
	Get(uid, friendUID int64) (*Contact, error)
	GetByKey(uid, friendUID, groupID, orgID int64) (*Contact, error)
	SyncList(uid, afterSeq, limit int64) ([]Contact, error)
	GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error)
	UpdateFriendProjections(uid int64, names map[int64]string, now int64) (int64, error)
	UpdateGroupProjections(uid int64, names map[int64]string, now int64) (int64, error)
	UpdateOrgProjections(uid int64, names map[int64]string, now int64) (int64, error)
	ListOrgIDs(uid int64) ([]int64, error)
}

// MessageStoreAPI defines message inbox operations.
type MessageStoreAPI interface {
	Insert(uid int64, msgID string, fromUID, toUID, groupID int64, msgType int8, body []byte, searchText string, sendTime int64) (int64, error)
	GetByMsgID(uid int64, msgID string) (*Message, error)
	ListByMsgIDs(uid int64, msgIDs []string) ([]Message, error)
	UpdateByMsgID(uid int64, msgID string, msgType int8, body []byte, searchText string) (bool, error)
	DeleteByMsgID(uid int64, msgID string) (seq int64, ok bool, err error)
	GetBySeq(uid, seq int64) (*Message, error)
	MaxSeq(uid int64) (int64, error)
	Sync(uid, lastSeq, limit int64) ([]Message, error)
	ListByConversation(uid, toUID, groupID, beforeSeq, limit int64) ([]Message, error)
	ListAfterByConversation(uid, toUID, groupID, afterSeq, limit int64) ([]Message, error)
	ListAroundByConversation(uid, toUID, groupID, aroundSeq, limit int64) ([]Message, error)
	Purge(uid int64, maxCount int64) (int64, error)
	ListPurgeable(maxCount, limit, afterUID int64) ([]int64, error)
}

type ConversationUnreadMode int8

const (
	ConversationUnreadKeep ConversationUnreadMode = iota
	ConversationUnreadReset
	ConversationUnreadIncrement
)

// ConversationStoreAPI defines conversation summary operations.
type ConversationStoreAPI interface {
	Upsert(uid, toUID, groupID, lastMsgSeq int64, msgID string, unreadMode ConversationUnreadMode) error
	ClearUnread(uid, toUID, groupID int64) error
	Delete(uid, toUID, groupID int64) (seq int64, ok bool, err error)
	List(uid, beforeSeq, afterSeq, limit int64) ([]Conversation, error)
	GetByTargets(uid int64, toUIDs, groupIDs []int64) ([]Conversation, error)
	Sync(uid, afterSeq, limit int64) ([]Conversation, error)
	Count(uid int64) (int64, error)
	TotalUnreadCount(uid int64) (int64, error)
	Purge(uid int64, maxCount int64) (int64, error)
	ListPurgeable(maxCount, limit, afterUID int64) ([]int64, error)
}

// BlocklistStoreAPI defines per-user blocklist operations.
type BlocklistStoreAPI interface {
	Upsert(uid, blockUID, now int64) (int64, error)
	Delete(uid, blockUID, now int64) (seq int64, ok bool, err error)
	Get(uid, blockUID int64) (*BlocklistEntry, error)
	List(uid, beforeSeq, limit int64) ([]BlocklistEntry, error)
	ListFiltered(uid int64, filter BlocklistFilter, beforeSeq, afterSeq, limit int64) ([]BlocklistEntry, error)
	Count(uid int64, filter BlocklistFilter) (int64, error)
	Sync(uid, afterSeq, limit int64) ([]BlocklistEntry, error)
	IsBlocked(uid, blockUID int64) (bool, error)
	Purge(uid int64) (int64, error)
	ListPurgeable(limit, afterUID int64) ([]int64, error)
	GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error)
}

// MutelistStoreAPI defines per-user conversation mutelist operations.
type MutelistStoreAPI interface {
	Upsert(uid, toUID, groupID int64, muted bool, now int64) (int64, error)
	Get(uid, toUID, groupID int64) (*MutelistEntry, error)
	List(uid, beforeSeq, limit int64) ([]MutelistEntry, error)
	ListFiltered(uid int64, filter MutelistFilter, beforeSeq, afterSeq, limit int64) ([]MutelistEntry, error)
	Count(uid int64, filter MutelistFilter) (int64, error)
	Sync(uid, afterSeq, limit int64) ([]MutelistEntry, error)
	Purge(uid int64) (int64, error)
	ListPurgeable(limit, afterUID int64) ([]int64, error)
	GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error)
}

// OrgStoreAPI defines org operations（org_id 分片）：org_info / tag_info 是
// 无 seq/status 的展示字典，tags 是唯一的同步域。
type OrgStoreAPI interface {
	UpsertOrgInfo(orgID int64, name, avatar string, now int64) error
	GetOrgInfo(orgID int64) (*OrgInfo, error)
	ListOrgInfos(orgIDs []int64) ([]OrgInfo, error)
	UpsertTagInfo(orgID, tagID int64, name, avatar string, now int64) error
	RenameTagInfo(orgID, tagID int64, name, avatar string, now int64) error
	GetTagInfo(orgID, tagID int64) (*TagInfo, error)
	ListTagInfos(orgID int64, tagIDs []int64) ([]TagInfo, error)
	DeleteTagInfo(orgID, tagID int64, now int64) (bool, error)
	UpsertTag(orgID, tagID, childID int64, childType uint8, title string, rank int64, sortKey string, role uint8, now int64) (seq int64, hadActive bool, err error)
	RemoveTag(orgID, tagID, childID int64, childType uint8, now int64) (removed bool, stillActive bool, err error)
	ListTagsPage(orgID, tagID int64, cursorParts []string, backward bool, limit int64) ([]Tag, error)
	SyncPage(orgID, afterSeq, limit int64) ([]Tag, bool, error)
	ListDirectMemberUIDs(orgID, tagID int64) ([]int64, error)
	ActiveMemberUIDs(orgID int64) ([]int64, error)
	UpdateMemberSortKeys(orgID, uid int64, sortKey string, now int64) (int64, error)
	WouldCreateCycle(orgID, parentTagID, childTagID int64) (bool, error)
	GetVersion(orgID int64) (gcSafeSeq, maxSeq int64, err error)
	Purge(orgID int64) (int64, error)
	ListPurgeable(limit, afterOrgID int64) ([]int64, error)
}

// GroupStoreAPI defines group metadata/member operations.
type GroupStoreAPI interface {
	CreateGroup(groupID int64, name string, ownerUID int64, memberUIDs []int64, now int64) error
	GetInfo(groupID int64) (*GroupInfo, error)
	ListByIDs(groupIDs []int64) ([]GroupInfo, error)
	UpdateInfo(groupID int64, name, avatar string, now int64) (bool, error)
	AddMember(groupID, uid int64, role int8, now int64) (bool, error)
	RemoveMember(groupID, uid int64) (bool, error)
	ListAllMembers(groupID int64) ([]GroupMember, error)
	ListMembersPage(groupID int64, cursorParts []string, backward bool, limit int64) ([]GroupMember, error)
	CountMembers(groupID int64) (int64, error)
	IsMember(groupID, uid int64) (bool, error)
}

var (
	_ UserStoreAPI         = (*UserStore)(nil)
	_ UserLookupStoreAPI   = (*UserLookupStore)(nil)
	_ SessionStoreAPI      = (*SessionStore)(nil)
	_ UserSessionStoreAPI  = (*UserSessionStore)(nil)
	_ ContactStoreAPI      = (*ContactStore)(nil)
	_ MessageStoreAPI      = (*MessageStore)(nil)
	_ ConversationStoreAPI = (*ConversationStore)(nil)
	_ BlocklistStoreAPI    = (*BlocklistStore)(nil)
	_ MutelistStoreAPI     = (*MutelistStore)(nil)
	_ GroupStoreAPI        = (*GroupStore)(nil)
	_ OrgStoreAPI          = (*OrgStore)(nil)
)
