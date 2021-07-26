/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either expressed or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { render } from '@testing-library/react';
import * as oneIngressFixture from './__fixtures__/2-ingresses.json';
import { wrapInTestApp } from '@backstage/test-utils';
import { IngressesAccordions } from './IngressesAccordions';
import { kubernetesProviders } from '../../hooks/test-utils';

describe('IngressesAccordions', () => {
  it('should render 1 ingress', async () => {
    const wrapper = kubernetesProviders(oneIngressFixture, new Set());

    const { getByText } = render(
      wrapper(wrapInTestApp(<IngressesAccordions />)),
    );

    expect(getByText('awesome-service')).toBeInTheDocument();
    expect(getByText('Ingress')).toBeInTheDocument();
  });
});
