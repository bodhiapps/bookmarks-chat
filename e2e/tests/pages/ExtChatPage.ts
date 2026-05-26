import { type BrowserContext, type Page, expect } from '@playwright/test';
import { EXTENSION_ID } from '../utils/extension-context';

export class ExtChatPage {
  constructor(private page: Page) {}

  selectors = {
    appTitle: '[data-testid="app-title"]',
    loginButton: '[data-testid="btn-auth-login"]',
    authenticated: '[data-testid="section-auth"][data-teststate="authenticated"]',
    clientReady: '[data-testid="badge-client-status"][data-teststate="ready"]',
    serverReady: '[data-testid="badge-server-status"][data-teststate="ready"]',
    refreshModels: '[data-testid="btn-refresh-models"]',
    modelSelector: '[data-testid="model-selector"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    chatInput: '[data-testid="chat-input"]',
    sendButton: '[data-testid="send-button"]',
    chatProcessing: '[data-testid="chat-processing"]',
    toolCall: '[data-testid="tool-call-message"]',
    message: (turn: number, role: string) =>
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`,
  };

  async waitForIndexed(_context: BrowserContext, expected: number): Promise<void> {
    await expect
      .poll(
        async () =>
          this.page.evaluate(
            () =>
              (window as unknown as { __bookmarksIndex?: { count: number } }).__bookmarksIndex
                ?.count ?? 0
          ),
        { timeout: 45000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThanOrEqual(expected);
  }

  async expectToolCalled(): Promise<void> {
    await this.page.locator(this.selectors.toolCall).first().waitFor();
  }

  async openApp(bodhiServerUrl: string): Promise<void> {
    const initParams = encodeURIComponent(
      JSON.stringify({
        extension: { timeoutMs: 500, attempts: 1, attemptWaitMs: 50, attemptTimeout: 100 },
      })
    );
    const url =
      `chrome-extension://${EXTENSION_ID}/index.html` +
      `?default-host=${encodeURIComponent(bodhiServerUrl)}&ext.initParams=${initParams}`;
    await this.page.goto(url);
    await this.page.locator(this.selectors.appTitle).waitFor();
    await this.page.locator(this.selectors.clientReady).waitFor();
    await this.page.locator(this.selectors.serverReady).waitFor();
  }

  async login(
    context: BrowserContext,
    creds: { username: string; password: string }
  ): Promise<void> {
    const popupPromise = context.waitForEvent('page');
    await this.page.locator(this.selectors.loginButton).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('load');

    await popup.getByRole('button', { name: 'Login', exact: true }).click();
    await popup.waitForSelector('#username');
    await popup.fill('#username', creds.username);
    await popup.fill('#password', creds.password);
    await popup.click('#kc-login');

    const approve = popup.getByTestId('review-approve-button');
    await approve.waitFor();
    const mcpToggles = popup.locator('[data-testid^="review-mcp-toggle-"]');
    const count = await mcpToggles.count();
    for (let i = 0; i < count; i++) {
      const toggle = mcpToggles.nth(i);
      if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
    }
    await expect(approve).toBeEnabled();
    await approve.click();

    await this.page.locator(this.selectors.authenticated).waitFor();
  }

  async loadModels(): Promise<void> {
    await this.page.locator(this.selectors.refreshModels).click();
    await expect(this.page.locator(this.selectors.modelSelector)).toBeEnabled();
  }

  async selectModel(modelId: string): Promise<void> {
    const trigger = this.page.locator(this.selectors.modelSelector);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await this.page.locator(this.selectors.modelSearchInput).fill(modelId);
    await this.page.getByTestId(`model-option-${modelId}`).click();
    await expect(trigger).toContainText(modelId);
  }

  async send(prompt: string): Promise<void> {
    await this.page.locator(this.selectors.chatInput).fill(prompt);
    await this.page.locator(this.selectors.sendButton).click();
  }

  async waitForAssistantTurn(turn: number): Promise<void> {
    await this.page.locator(this.selectors.message(turn, 'assistant')).waitFor();
    await this.page.locator(this.selectors.chatProcessing).waitFor({ state: 'hidden' });
  }

  async getAssistantText(turn: number): Promise<string> {
    return (await this.page.locator(this.selectors.message(turn, 'assistant')).textContent()) ?? '';
  }
}
