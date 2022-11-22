/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getVoidLogger } from '@backstage/backend-common';
import { TestEventSubscriber } from '@backstage/plugin-events-backend-test-utils';
import { InMemoryEventBroker } from './InMemoryEventBroker';

const logger = getVoidLogger();

describe('InMemoryEventBroker', () => {
  it('passes events to interested subscribers', () => {
    const subscriber1 = new TestEventSubscriber('test1', ['topicA', 'topicB']);
    const subscriber2 = new TestEventSubscriber('test2', ['topicB', 'topicC']);
    const eventBroker = new InMemoryEventBroker(logger);

    eventBroker.subscribe(subscriber1);
    eventBroker.subscribe(subscriber2);
    eventBroker.publish({ topic: 'topicA', eventPayload: { test: 'topicA' } });
    eventBroker.publish({ topic: 'topicB', eventPayload: { test: 'topicB' } });
    eventBroker.publish({ topic: 'topicC', eventPayload: { test: 'topicC' } });
    eventBroker.publish({ topic: 'topicD', eventPayload: { test: 'topicD' } });

    expect(Object.keys(subscriber1.receivedEvents)).toEqual([
      'topicA',
      'topicB',
    ]);
    expect(subscriber1.receivedEvents.topicA.length).toEqual(1);
    expect(subscriber1.receivedEvents.topicA[0]).toEqual({
      topic: 'topicA',
      eventPayload: { test: 'topicA' },
    });
    expect(subscriber1.receivedEvents.topicB.length).toEqual(1);
    expect(subscriber1.receivedEvents.topicB[0]).toEqual({
      topic: 'topicB',
      eventPayload: { test: 'topicB' },
    });

    expect(Object.keys(subscriber2.receivedEvents)).toEqual([
      'topicB',
      'topicC',
    ]);
    expect(subscriber2.receivedEvents.topicB.length).toEqual(1);
    expect(subscriber2.receivedEvents.topicB[0]).toEqual({
      topic: 'topicB',
      eventPayload: { test: 'topicB' },
    });
    expect(subscriber2.receivedEvents.topicC.length).toEqual(1);
    expect(subscriber2.receivedEvents.topicC[0]).toEqual({
      topic: 'topicC',
      eventPayload: { test: 'topicC' },
    });
  });
});
