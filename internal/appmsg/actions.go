package appmsg

const (
	ActionAcceptFriend       = "accept_friend"
	ActionAddFriend          = "add_friend"
	ActionAddGroupMember     = "add_group_member"
	ActionAuthenticate       = "authenticate"
	ActionBlockUser          = "block_user"
	ActionCreateGroup        = "create_group"
	ActionDeleteConversation = "delete_conversation"
	ActionDeleteFriend       = "delete_friend"
	ActionDeleteMessage      = "delete_message"
	ActionFavoriteGroup      = "favorite_group"
	ActionGetBlocklist       = "get_blocklist"
	ActionGetContacts        = "get_contacts"
	ActionGetConversations   = "get_conversations"
	ActionGetGroupInfos      = "get_group_infos"
	ActionGetGroupMembers    = "get_group_members"
	ActionGetMessages        = "get_messages"
	ActionGetMutelist        = "get_mutelist"
	ActionGetContactCount    = "get_contact_count"
	ActionGetUnreadCount     = "get_unread_count"
	ActionGetUserInfos       = "get_user_infos"
	ActionLogin              = "login"
	ActionLogout             = "logout"
	ActionClearUnread        = "clear_unread"
	ActionMuteConversation   = "mute_conversation"
	ActionPing               = "ping"
	ActionRegister           = "register"
	ActionRejectFriend       = "reject_friend"
	ActionRemoveGroupMember  = "remove_group_member"
	ActionSearchUser         = "search_user"
	ActionSendMessage        = "send_message"
	ActionSyncBlocklist      = "sync_blocklist"
	ActionSyncContacts       = "sync_contacts"
	ActionSyncConversations  = "sync_conversations"
	ActionSyncMessages       = "sync_messages"
	ActionSyncMutelist       = "sync_mutelist"
	ActionUnblockUser        = "unblock_user"
	ActionUnfavoriteGroup    = "unfavorite_group"
	ActionUnmuteConversation = "unmute_conversation"
	ActionUpdateGroupInfo    = "update_group_info"
	ActionUpdatePassword     = "update_password"
	ActionUpdateRemark       = "update_remark"
	ActionUpdateUserInfo     = "update_user_info"
)

var coreActionAuth = map[string]bool{
	ActionAcceptFriend:       true,
	ActionAddFriend:          true,
	ActionAddGroupMember:     true,
	ActionAuthenticate:       false,
	ActionBlockUser:          true,
	ActionCreateGroup:        true,
	ActionDeleteConversation: true,
	ActionDeleteFriend:       true,
	ActionDeleteMessage:      true,
	ActionFavoriteGroup:      true,
	ActionGetBlocklist:       true,
	ActionGetContacts:        true,
	ActionGetConversations:   true,
	ActionGetGroupInfos:      true,
	ActionGetGroupMembers:    true,
	ActionGetMessages:        true,
	ActionGetMutelist:        true,
	ActionGetContactCount:    true,
	ActionGetUnreadCount:     true,
	ActionGetUserInfos:       true,
	ActionLogin:              false,
	ActionLogout:             true,
	ActionClearUnread:        true,
	ActionMuteConversation:   true,
	ActionPing:               true,
	ActionRegister:           false,
	ActionRejectFriend:       true,
	ActionRemoveGroupMember:  true,
	ActionSearchUser:         true,
	ActionSendMessage:        true,
	ActionSyncBlocklist:      true,
	ActionSyncContacts:       true,
	ActionSyncConversations:  true,
	ActionSyncMessages:       true,
	ActionSyncMutelist:       true,
	ActionUnblockUser:        true,
	ActionUnfavoriteGroup:    true,
	ActionUnmuteConversation: true,
	ActionUpdateGroupInfo:    true,
	ActionUpdatePassword:     true,
	ActionUpdateRemark:       true,
	ActionUpdateUserInfo:     true,
}

// CoreActionRequiresAuth reports whether a core action requires authentication.
// Unknown actions default to requiring auth so plugins cannot bypass auth accidentally.
func CoreActionRequiresAuth(action string) bool {
	if auth, ok := coreActionAuth[action]; ok {
		return auth
	}
	return true
}
