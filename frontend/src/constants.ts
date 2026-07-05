export const MSG_TYPE_TEXT = 1 as const;
export const MSG_TYPE_IMAGE = 2 as const;
export const MSG_TYPE_SYSTEM = 3 as const;
export const MSG_TYPE_FILE = 4 as const;
export const MSG_TYPE_RECALL = 5 as const;
export const MSG_TYPE_QUOTE = 6 as const;
export const MSG_TYPE_FORWARD = 7 as const;
export const MSG_TYPE_MARKDOWN = 8 as const;

export const CONTACT_FRIEND = 1;
export const CONTACT_DELETED = 0xff;
export const CONTACT_PENDING = 2;
export const BLOCKLIST_ACTIVE = 1;
export const MUTELIST_ACTIVE = 1;
export const STATUS_DELETED = 0xff;

export const GROUP_ROLE_MEMBER = 0 as const;
export const GROUP_ROLE_OWNER = 2 as const;
