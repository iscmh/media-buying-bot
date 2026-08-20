import type { Config } from '../config.js';
import type { Source } from '../types.js';
import { ApiSource } from './api.js';
import { BrowserSource } from './browser.js';
import { MockSource } from './mock.js';

export function createSource(cfg: Config): Source {
  switch (cfg.TRACKER_SOURCE) {
    case 'api':
      return new ApiSource(cfg);
    case 'browser':
      return new BrowserSource(cfg);
    case 'mock':
      return new MockSource(cfg);
  }
}

export { ApiSource, BrowserSource, MockSource };
