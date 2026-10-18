/**
 * Chat that authors a graph.
 *
 * ONE endpoint does both jobs, from day one:
 *
 *   POST /api/conversations/:id/messages  { text }  ->  { message, graph }
 *
 * The first turn passes `currentGraph: null` and builds a graph; a later turn
 * passes the graph being edited and modifies it. Same route, same prompt
 * template, same response shape -- which is why conversational editing needed
 * no second code path.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { Conversation, ConversationMessage } from '@htn/shared';
import { newId, nowIso } from '../lib/ids.js';
import { store } from '../store/index.js';
import { mutateGraph } from '../services/graphs.service.js';
import { saveGraphOwned } from '../services/graphCompile.service.js';
import { synthesiseGraph } from '../services/synthesis.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

export const conversationsRouter: Router = Router();

const messageSchema = z.object({ text: z.string().min(1).max(4000) });

/**
 * `graphId` is optional and, when given, SEEDS the conversation with the graph
 * it should edit.
 *
 * Without this there is no way to open an existing graph, describe a change,
 * and have the chat modify THAT graph: `graphId` is set only by the first
 * message a conversation itself produces (see the handler below), so chatting
 * from a page that already has a graph loaded would silently build an
 * unrelated new one instead of editing what's on screen.
 */
const createConversationSchema = z.object({ graphId: z.string().min(1).optional() });

conversationsRouter.get('/conversations', async (_req, res) => {
  res.json({ conversations: await store.listConversations() });
});

conversationsRouter.post('/conversations', validate(createConversationSchema), async (req, res) => {
  const { graphId } = valid<z.infer<typeof createConversationSchema>>(req, 'body');

  // A bad id here would otherwise surface later as a confusing 404 or,
  // worse, be silently ignored by synthesis's own currentGraph lookup.
  if (graphId && !(await store.getGraph(graphId))) {
    throw new HttpError(404, 'NOT_FOUND', 'No graph with id "' + graphId + '"');
  }

  const at = nowIso();
  const conversation: Conversation = {
    id: newId('conv'),
    title: 'New workflow',
    graphId,
    messages: [],
    createdAt: at,
    updatedAt: at,
  };
  res.status(201).json({ conversation: await store.saveConversation(conversation) });
});

conversationsRouter.get('/conversations/:id', async (req, res) => {
  const conversation = await store.getConversation(param(req, 'id'));
  if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');

  const graph = conversation.graphId ? await store.getGraph(conversation.graphId) : null;
  res.json({ conversation, graph });
});

conversationsRouter.post(
  '/conversations/:id/messages',
  validate(messageSchema),
  async (req, res) => {
    const { text } = valid<z.infer<typeof messageSchema>>(req, 'body');
    const id = param(req, 'id');

    const conversation = await store.getConversation(id);
    if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');

    const currentGraph = conversation.graphId ? await store.getGraph(conversation.graphId) : null;

    // The conversation id is the egress ledger key, so the synthesis call is
    // recorded like any other outbound call. A graph's real cost includes the
    // call that produced it.
    const result = await synthesiseGraph({
      conversationId: conversation.id,
      request: text,
      currentGraph,
    });

    // An existing graph is UPDATED through the same mutateGraph every other
    // writer uses, so a chat edit cannot bypass the cycle and reference checks.
    const saved = currentGraph
      ? await mutateGraph(currentGraph.id, currentGraph.version, () => result.graph)
      : await saveGraphOwned(result.graph);

    const at = nowIso();
    const userMessage: ConversationMessage = {
      id: newId('msg'),
      role: 'user',
      text,
      at,
    };
    const assistantMessage: ConversationMessage = {
      id: newId('msg'),
      role: 'assistant',
      text: result.message,
      at: nowIso(),
      graphVersion: saved.version,
    };

    const updated: Conversation = {
      ...conversation,
      // Name the conversation after whatever the first request produced.
      title: conversation.messages.length === 0 ? saved.name : conversation.title,
      graphId: saved.id,
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: nowIso(),
    };
    await store.saveConversation(updated);

    res.json({
      conversation: updated,
      message: assistantMessage,
      graph: saved,
      // Surfaced so the UI can show what was left to runtime rather than
      // pinned at authoring time. See shared/delegation.ts.
      delegation: result.delegation,
    });
  },
);
