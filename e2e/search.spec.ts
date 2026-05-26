import { test, expect } from '@playwright/test';
import { getTestState, FULL_MODEL_ID } from './tests/global-setup';
import { launchExtension } from './tests/utils/extension-context';
import { ExtChatPage } from './tests/pages/ExtChatPage';
import { BOOKMARK_FIXTURES, UNIQUE_TERM } from './fixtures/bookmarks';

test('search_bookmarks returns a seeded bookmark in a markdown table', async () => {
  const { bodhiServerUrl, username, password } = getTestState();
  const context = await launchExtension();
  try {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await sw.evaluate(async fixtures => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'E2E' });
      for (const b of fixtures) {
        await chrome.bookmarks.create({ parentId: folder.id, title: b.title, url: b.url });
      }
    }, BOOKMARK_FIXTURES);

    const page = await context.newPage();
    const chat = new ExtChatPage(page);
    await chat.openApp(bodhiServerUrl);
    await chat.login(context, { username, password });

    await chat.waitForIndexed(context, BOOKMARK_FIXTURES.length);

    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);
    await chat.send(`search my bookmarks for ${UNIQUE_TERM} and show the results as a table`);
    await chat.waitForAssistantTurn(0);

    await chat.expectToolCalled();
    const reply = await chat.getAssistantText(0);
    expect(reply.toLowerCase()).toContain(UNIQUE_TERM.toLowerCase());
  } finally {
    await context.close();
  }
});
