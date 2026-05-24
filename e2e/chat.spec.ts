import { test, expect } from '@playwright/test';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { launchExtension } from './tests/utils/extension-context';
import { ExtChatPage } from './tests/pages/ExtChatPage';

test.describe('Demo Chat Application', () => {
  test('chat answers what day comes after monday with tuesday', async () => {
    const { username, password, bodhiServerUrl } = getTestState();
    const context = await launchExtension();
    try {
      const page = await context.newPage();
      const chat = new ExtChatPage(page);
      await chat.openApp(bodhiServerUrl);
      await chat.login(context, { username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('what day comes after monday? answer in one word');
      await chat.waitForAssistantTurn(0);

      const reply = await chat.getAssistantText(0);
      expect(reply.toLowerCase()).toContain('tuesday');
    } finally {
      await context.close();
    }
  });
});
