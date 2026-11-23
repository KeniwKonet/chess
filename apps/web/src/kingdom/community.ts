/**
 * The community chat in the browser: the messages, who's here, the small
 * leaderboard, and sending messages and cards. The server checks everything
 * (accounts, limits, cards); see apps/server/src/online/community.ts.
 */
import { create } from 'zustand';
import type { ChatMessage, ChatShare, CommunityBoard, CommunityServerMsg } from '@cr/chess-core';
import { send, useOnline } from './online';

interface CommunityState {
  open: boolean;
  loaded: boolean;
  messages: ChatMessage[];
  board: CommunityBoard | null;
  online: number;
  /** Messages that arrived while the community tab wasn't showing. */
  unseen: number;
}

export const useCommunity = create<CommunityState>(() => ({ open: false, loaded: false, messages: [], board: null, online: 0, unseen: 0 }));

let watching = false;

export function openCommunity() {
  // After a dropped connection, ask for the room again (it brings any missed messages).
  // (Subscribed here rather than at load: online.ts and this file import each other.)
  if (!watching) {
    watching = true;
    useOnline.subscribe((s, prev) => {
      if (s.link === 'open' && prev.link !== 'open' && useCommunity.getState().open) send({ t: 'chat-open' });
    });
  }
  useCommunity.setState({ open: true, unseen: 0 });
  send({ t: 'chat-open' });
}

export function closeCommunity() {
  if (!useCommunity.getState().open) return;
  useCommunity.setState({ open: false });
  send({ t: 'chat-close' });
}

export const say = (text: string) => send({ t: 'chat-say', text });
export const shareCard = (what: ChatShare, text = '') => send({ t: 'chat-share', what, ...(text ? { text } : {}) });
export const removeMessage = (id: number) => send({ t: 'chat-delete', id });

export function handleCommunity(m: CommunityServerMsg) {
  switch (m.t) {
    case 'chat':
      return useCommunity.setState({ loaded: true, messages: m.messages, board: m.board, online: m.online });
    case 'chat-new':
      return useCommunity.setState((s) => ({
        messages: [...s.messages.filter((x) => x.id !== m.message.id), m.message].slice(-100),
        unseen: s.open ? 0 : s.unseen + 1,
      }));
    case 'chat-gone':
      return useCommunity.setState((s) => ({ messages: s.messages.filter((x) => x.id !== m.id) }));
    case 'chat-online':
      return useCommunity.setState({ online: m.online });
  }
}

