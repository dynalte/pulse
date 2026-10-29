/** Types partagés avec l'API PHP (api/api-messagerie.php). */

export type UserRole = 'admin' | 'member';
export type ConversationType = 'direct' | 'group';
export type ConversationRole = 'owner' | 'admin' | 'member';
export type MessageType = 'text' | 'image' | 'voice' | 'file' | 'system';
export type MediaKind = 'image' | 'voice' | 'file';
export type PrivacyValue = 'everyone' | 'contacts' | 'nobody';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface User {
  id: number;
  username: string;
  name: string;
  bio: string;
  phone: string;
  email?: string;
  avatarId: number | null;
  role: UserRole;
  active?: boolean;
  createdAt: number;
  lastSeen: number;
  online: boolean;
  isContact?: boolean;
  hasDirect?: boolean;
  directId?: number | null;
  blocked?: boolean;
  blockedBy?: boolean;
}

export interface NotifPrefs {
  enabled: boolean;
  messages: boolean;
  groups: boolean;
  preview: boolean;
  sound: boolean;
  badge: boolean;
}

export interface PrivacyPrefs {
  lastSeen: PrivacyValue;
  profilePhoto: PrivacyValue;
}

export interface Me extends User {
  notif: NotifPrefs;
  privacy: PrivacyPrefs;
  unreadTotal: number;
  pushDevices?: number;
}

export interface Media {
  id: number;
  kind: MediaKind;
  mime: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  filename: string;
  waveform: number[];
}

export interface Reaction {
  userId: number;
  name: string;
  emoji: string;
}

export interface ReplyPreview {
  id: number;
  senderId: number;
  senderName: string;
  type: MessageType;
  body: string;
  deleted: boolean;
  mediaId: number | null;
}

export interface Message {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  senderUsername: string;
  senderAvatarId: number | null;
  type: MessageType;
  body: string;
  media: Media | null;
  replyTo: ReplyPreview | null;
  reactions: Reaction[];
  readCount: number;
  deliveredCount: number;
  otherCount?: number;
  starred: boolean;
  editedAt: number;
  deletedAt: number;
  createdAt: number;
  expiresAt: number;
  forwarded: boolean;
  mine: boolean;
  conversationTitle?: string;
}

export interface LastMessage {
  id: number;
  senderId: number;
  senderName: string;
  type: MessageType;
  body: string;
  mediaId: number | null;
  createdAt: number;
  deleted: boolean;
}

export interface ConversationMember {
  id: number;
  username: string;
  name: string;
  avatarId: number | null;
  role: ConversationRole;
  lastSeen: number;
  online: boolean;
  lastReadMessageId: number;
  mutedUntil: number;
}

export interface Conversation {
  id: number;
  type: ConversationType;
  title: string;
  description: string;
  avatarId: number | null;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  members: ConversationMember[];
  peer: User | null;
  unread: number;
  lastReadMessageId: number;
  lastDeliveredMessageId: number;
  myRole: ConversationRole | null;
  mutedUntil: number;
  pinned: number;
  archived: number;
  inviteCode: string;
  disappearingSeconds: number;
  onlyAdminsCanPost: number;
  memberCount: number;
  lastMessage: LastMessage | null;
  blocked: boolean;
}

export interface TypingUser {
  conversationId: number;
  userId: number;
  name: string;
  until: number;
}

export interface Invite {
  id: number;
  code: string;
  email: string;
  note: string;
  maxUses: number;
  uses: number;
  role: UserRole;
  createdAt: number;
  expiresAt: number;
  creatorName: string;
  createdBy: number;
  used?: boolean;
}

export interface InviteInfo {
  kind: 'account' | 'group';
  code: string;
  valid: boolean;
  email: string;
  note: string;
  creatorName: string;
  groupName?: string;
  groupMemberCount?: number;
  expiresAt: number;
  reason?: string;
  needsAuth?: boolean;
}

export interface SyncResponse {
  ok: true;
  now: number;
  me: { unreadTotal: number; lastSeen: number };
  conversations: Conversation[];
  events: Message[];
  messages?: Message[];
  updates?: Message[];
  typing?: TypingUser[];
  presence?: { userId: number; lastSeen: number; online: boolean }[];
  readStates?: { conversationId: number; userId: number; lastReadMessageId: number }[];
  deletedConversations?: number[];
}

export interface SearchResults {
  conversations: Conversation[];
  users: User[];
  messages: (Message & { conversationTitle: string })[];
}

export interface AdminStats {
  users: number;
  activeUsers: number;
  conversations: number;
  messages: number;
  mediaCount: number;
  mediaBytes: number;
  online: number;
}
