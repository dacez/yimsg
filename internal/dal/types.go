package dal

// User is the full user record. PasswordHash is excluded from JSON via json:"-".
type User struct {
	UID          int64  `json:"uid,string"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	Nickname     string `json:"nickname"`
	Avatar       string `json:"avatar"`
	Remark       string `json:"remark,omitempty"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

// Session represents an authentication session (token shard).
type Session struct {
	Token     string `json:"token"`
	UID       int64  `json:"uid,string"`
	CreatedAt int64  `json:"created_at"`
	ExpireAt  int64  `json:"expire_at"`
}

// UserSession represents a token index entry (uid shard).
type UserSession struct {
	UID       int64  `json:"uid,string"`
	Token     string `json:"token"`
	Device    string `json:"device"`
	CreatedAt int64  `json:"created_at"`
}

const (
	ContactTypeFriend int64 = 1
	ContactTypeGroup  int64 = 2
	ContactTypeOrg    int64 = 3
)

// Contact represents a contact relationship (friend, favorited group, or org membership).
// Type/ID 是 contacts 表的统一目标键；FriendUID/GroupID/OrgID 是对外兼容投影字段。
type Contact struct {
	UID        int64  `json:"uid,string"`
	Type       int64  `json:"type"`
	ID         int64  `json:"id,string"`
	FriendUID  int64  `json:"friend_uid,string"`
	GroupID    int64  `json:"group_id,string"`
	OrgID      int64  `json:"org_id,string"`
	Status     uint8  `json:"status"`
	RemarkName string `json:"remark_name"`
	// SortKey 是通讯录排序键投影：有备注按备注、否则按昵称/群名/组织名归一化生成。
	SortKey string `json:"sort_key"`
	// SearchText 是通讯录搜索投影：拼接 remark_name 与昵称/群名/组织名，明确不含 username。
	SearchText string `json:"search_text"`
	Seq        int64  `json:"seq"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
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
	Seq        int64  `json:"seq"`
	MsgID      string `json:"msg_id"`
	FromUID    int64  `json:"from_uid,string"`
	ToUID      int64  `json:"to_uid,string"`
	GroupID    int64  `json:"group_id,string"`
	MsgType    int8   `json:"msg_type"`
	Body       []byte `json:"body"`
	SearchText string `json:"search_text"`
	SendTime   int64  `json:"send_time"`
	Status     uint8  `json:"status"`
}

const (
	MessageActive  uint8 = 1
	MessageDeleted uint8 = 0xff

	ConversationActive  uint8 = 1
	ConversationDeleted uint8 = 0xff
)

// Conversation represents a conversation summary in a user's inbox.
type Conversation struct {
	ToUID       int64  `json:"to_uid,string"`
	GroupID     int64  `json:"group_id,string"`
	Seq         int64  `json:"seq"`
	LastMsgID   string `json:"last_msg_id"`
	UnreadCount int64  `json:"unread_count"`
	Status      uint8  `json:"status"`
}

// BlocklistEntry represents one blocklist row owned by a user.
type BlocklistEntry struct {
	UID       int64 `json:"-"`
	BlockUID  int64 `json:"uid,string"`
	Status    uint8 `json:"status,omitempty"`
	Seq       int64 `json:"seq"`
	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

type BlocklistFilter struct {
	Status *uint8
	UIDs   []int64
}

// MutelistEntry represents one per-conversation mutelist setting.
type MutelistEntry struct {
	UID       int64 `json:"-"`
	ToUID     int64 `json:"to_uid,string"`
	GroupID   int64 `json:"group_id,string"`
	Status    uint8 `json:"status"`
	Seq       int64 `json:"seq"`
	UpdatedAt int64 `json:"updated_at,omitempty"`
}

const (
	MutelistActive  uint8 = 1
	MutelistDeleted uint8 = 0xff
)

// GroupInfo represents group metadata.
type GroupInfo struct {
	GroupID   int64  `json:"group_id,string"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	Remark    string `json:"remark,omitempty"`
	OwnerUID  int64  `json:"owner_uid,string"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// GroupMember represents a group membership record.
type GroupMember struct {
	GroupID  int64 `json:"group_id,string"`
	UID      int64 `json:"uid,string"`
	Role     int8  `json:"role"`
	JoinedAt int64 `json:"joined_at"`
}

// Constants for contact status.
const (
	ContactFriend  uint8 = 1
	ContactPending uint8 = 2
	ContactDeleted uint8 = 0xff
)

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

// Constants for tags child_type：区分一行挂载的子项是人还是 tag。
const (
	TagChildPerson uint8 = 1
	TagChildTag    uint8 = 2
)

// Constants for tags role：标识子项在其挂载节点下是否为管理员。
const (
	TagRoleMember uint8 = 1
	TagRoleAdmin  uint8 = 2
)

// TagRankUnset 表示边未显式排序：自然沉到所有显式排序之后，落到 sort_key 字典序。
const TagRankUnset int64 = 2147483647

// OrgInfo 是组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。
type OrgInfo struct {
	OrgID     int64  `json:"org_id,string"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// TagInfo 是 tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。
type TagInfo struct {
	OrgID     int64  `json:"org_id,string"`
	TagID     int64  `json:"tag_id,string"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// Tag 是 tags（组织关系表）条目：组织架构唯一的同步域。一行表示"某父节点
// （TagID，组织根传 OrgID）下挂一个子项"，ChildType 区分子项是人
// （TagChildPerson，ChildID=uid）还是 tag（TagChildTag，ChildID=tag_id）。
// Rank / Title / SortKey / Role 都是这条边的属性，一人多岗即多条边、各边独立。
type Tag struct {
	OrgID     int64  `json:"org_id,string"`
	TagID     int64  `json:"tag_id,string"`
	ChildID   int64  `json:"child_id,string"`
	ChildType uint8  `json:"child_type"`
	Title     string `json:"title"`
	Rank      int64  `json:"rank"`
	SortKey   string `json:"sort_key"`
	Role      uint8  `json:"role"`
	Status    uint8  `json:"status"`
	Seq       int64  `json:"seq"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
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
