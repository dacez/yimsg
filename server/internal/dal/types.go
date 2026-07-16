package dal

import "errors"

// User is the full user record. PasswordHash is excluded from JSON via json:"-".
type User struct {
	UID          int64
	Username     string
	PasswordHash string
	Nickname     string
	Avatar       string
	Remark       string
	CreatedAt    int64
	UpdatedAt    int64
}

// Session represents an authentication session (token shard).
type Session struct {
	Token     string
	UID       int64
	CreatedAt int64
	ExpireAt  int64
}

// UserSession represents a token index entry (uid shard).
type UserSession struct {
	UID       int64
	Token     string
	Device    string
	CreatedAt int64
}

const (
	ContactTypeFriend int64 = 1
	ContactTypeGroup  int64 = 2
	ContactTypeOrg    int64 = 3
)

// Contact represents a contact relationship (friend, favorited group, or org membership).
// Type/ID 是 contacts 表的统一目标键；FriendUID/GroupID/OrgID 是对外兼容投影字段。
type Contact struct {
	UID        int64
	Type       int64
	ID         int64
	FriendUID  int64
	GroupID    int64
	OrgID      int64
	Status     uint8
	RemarkName string
	// SortKey 是通讯录排序键投影：有备注按备注、否则按昵称/群名/组织名归一化生成。
	SortKey string
	// SearchText 是通讯录搜索投影：拼接 remark_name 与昵称/群名/组织名，明确不含 username。
	SearchText string
	Seq        int64
	CreatedAt  int64
	UpdatedAt  int64
}

type ContactListFilter struct {
	Status     *uint8
	FriendUID  int64
	GroupID    int64
	OrgID      int64
	FriendUIDs []int64
	GroupIDs   []int64
	OrgIDs     []int64
}

// Message represents a message in a user's inbox.
// Body 存储 protobuf 编码后的 MessageBody（不能为空 bytes）；SearchText 是搜索投影，不作为真实内容来源。
type Message struct {
	Seq        int64
	MsgID      string
	FromUID    int64
	ToUID      int64
	GroupID    int64
	MsgType    int8
	Body       []byte
	SearchText string
	SendTime   int64
	Status     uint8
}

const (
	MessageActive  uint8 = 1
	MessageDeleted uint8 = 0xff

	ConversationActive  uint8 = 1
	ConversationDeleted uint8 = 0xff
)

// Conversation represents a conversation summary in a user's inbox.
type Conversation struct {
	ToUID       int64
	GroupID     int64
	Seq         int64
	LastMsgID   string
	UnreadCount int64
	Status      uint8
}

// BlocklistEntry represents one blocklist row owned by a user.
type BlocklistEntry struct {
	UID       int64
	BlockUID  int64
	Status    uint8
	Seq       int64
	CreatedAt int64
	UpdatedAt int64
}

type BlocklistFilter struct {
	Status *uint8
	UIDs   []int64
}

// MutelistEntry represents one per-conversation mutelist setting.
type MutelistEntry struct {
	UID       int64
	ToUID     int64
	GroupID   int64
	Status    uint8
	Seq       int64
	UpdatedAt int64
}

const (
	MutelistActive  uint8 = 1
	MutelistDeleted uint8 = 0xff
)

// GroupInfo represents group metadata.
type GroupInfo struct {
	GroupID   int64
	Name      string
	Avatar    string
	Remark    string
	OwnerUID  int64
	CreatedAt int64
	UpdatedAt int64
}

// GroupMember represents a group membership record.
type GroupMember struct {
	GroupID  int64
	UID      int64
	Role     int8
	JoinedAt int64
}

// Constants for contact status.
// ContactPendingOutgoing 是申请方自身的记录（等对方处理），ContactPendingIncoming 是被申请方自身的记录（等自己处理）；
// 二者不可互换，accept/reject 只能作用于 ContactPendingIncoming 一侧。
const (
	ContactFriend          uint8 = 1
	ContactPendingOutgoing uint8 = 2
	ContactPendingIncoming uint8 = 3
	ContactDeleted         uint8 = 0xff
)

// IsPendingStatus 报告该状态是否属于待处理好友申请（无论方向）；两者展示序都按 seq 倒序。
func IsPendingStatus(status uint8) bool {
	return status == ContactPendingOutgoing || status == ContactPendingIncoming
}

// Constants for blocklist status.
const (
	BlocklistActive  uint8 = 1
	BlocklistDeleted uint8 = 0xff
)

type MutelistFilter struct {
	Status   *uint8
	ToUID    int64
	GroupID  int64
	ToUIDs   []int64
	GroupIDs []int64
}

// Constants for group roles.
const (
	RoleMember int8 = 0
	RoleOwner  int8 = 2
)

// Constants for tags status.
const (
	TagActive  uint8 = 1
	TagDeleted uint8 = 0xff
)

// Constants for tags child_type：区分一行挂载的子项是人、tag 还是管理员授权。
// GRANT 行（child_id=uid）与组织架构位置解耦：表示该用户被授权管理 tag_id 为根
// 的整棵子树，不代表他在这个节点下有职位，不出现在展开/同步结果里，只通过
// CanManage 与 ListGrantedAdmins 读取。
const (
	TagChildPerson uint8 = 1
	TagChildTag    uint8 = 2
	TagChildGrant  uint8 = 3
)

// TagRankUnset 表示边未显式排序：自然沉到所有显式排序之后，落到 sort_key 字典序。
const TagRankUnset int64 = 2147483647

// ErrOrgLastRootAdmin 表示撤销这条 GRANT 边会让组织根失去最后一个管理员，
// 拒绝执行。校验与删除在同一事务内完成（见 OrgStore.RevokeOrgAdmin），
// 避免并发撤权绕过"组织至少一个根管理员"的约束。
var ErrOrgLastRootAdmin = errors.New("org root would lose its last admin")

// OrgInfo 是组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。
type OrgInfo struct {
	OrgID     int64
	Name      string
	Avatar    string
	CreatedAt int64
	UpdatedAt int64
}

// TagInfo 是 tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。
type TagInfo struct {
	OrgID     int64
	TagID     int64
	Name      string
	Avatar    string
	CreatedAt int64
	UpdatedAt int64
}

// Tag 是 tags（组织关系表）条目：组织架构唯一的同步域。一行表示"某父节点
// （TagID，组织根传 OrgID）下挂一个子项"，ChildType 区分子项是人
// （TagChildPerson，ChildID=uid）、tag（TagChildTag，ChildID=tag_id）还是
// 管理员授权（TagChildGrant，ChildID=uid，与组织架构位置解耦）。
// Rank / Title / SortKey 都是这条边的属性，一人多岗即多条边、各边独立。
type Tag struct {
	OrgID     int64
	TagID     int64
	ChildID   int64
	ChildType uint8
	Title     string
	Rank      int64
	SortKey   string
	Status    uint8
	Seq       int64
	CreatedAt int64
	UpdatedAt int64
}

// Constants for message types. 必须与 protobuf MessageType 一致。
const (
	MsgText     int8 = 1
	MsgImage    int8 = 2
	MsgSystem   int8 = 3
	MsgFile     int8 = 4
	MsgRecall   int8 = 5
	MsgQuote    int8 = 6
	MsgForward  int8 = 7
	MsgMarkdown int8 = 8
)
