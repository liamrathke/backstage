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
import React from 'react';
import { TemplateParameterSchema } from '../../../types';
import { Stepper } from './Stepper';
import { renderInTestApp } from '@backstage/test-utils';
import { act, fireEvent } from '@testing-library/react';
import type { RJSFValidationError } from '@rjsf/utils';
import { JsonValue } from '@backstage/types';

describe('Stepper', () => {
  it('should render the step titles for each step of the manifest', async () => {
    const manifest: TemplateParameterSchema = {
      steps: [
        { title: 'Step 1', schema: { properties: {} } },
        { title: 'Step 2', schema: { properties: {} } },
      ],
      title: 'React JSON Schema Form Test',
    };

    const { getByText } = await renderInTestApp(
      <Stepper manifest={manifest} extensions={[]} onComplete={jest.fn()} />,
    );

    for (const step of manifest.steps) {
      expect(getByText(step.title)).toBeInTheDocument();
    }
  });

  it('should render next / review button', async () => {
    const manifest: TemplateParameterSchema = {
      steps: [
        { title: 'Step 1', schema: { properties: {} } },
        { title: 'Step 2', schema: { properties: {} } },
      ],
      title: 'React JSON Schema Form Test',
    };

    const { getByRole } = await renderInTestApp(
      <Stepper manifest={manifest} extensions={[]} onComplete={jest.fn()} />,
    );

    expect(getByRole('button', { name: 'Next' })).toBeInTheDocument();

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Next' }));
    });

    expect(getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  it('should remember the state of the form when cycling through the pages', async () => {
    const manifest: TemplateParameterSchema = {
      steps: [
        {
          title: 'Step 1',
          schema: {
            properties: {
              name: {
                type: 'string',
              },
            },
          },
        },
        {
          title: 'Step 2',
          schema: {
            properties: {
              description: {
                type: 'string',
              },
            },
          },
        },
      ],
      title: 'React JSON Schema Form Test',
    };

    const { getByRole } = await renderInTestApp(
      <Stepper manifest={manifest} extensions={[]} onComplete={jest.fn()} />,
    );

    await fireEvent.change(getByRole('textbox', { name: 'name' }), {
      target: { value: 'im a test value' },
    });

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Next' }));
    });

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Back' }));
    });

    expect(getByRole('textbox', { name: 'name' })).toHaveValue(
      'im a test value',
    );
  });

  it('should render custom field extensions properly', async () => {
    const MockComponent = () => {
      return <h1>im a custom field extension</h1>;
    };

    const manifest: TemplateParameterSchema = {
      title: 'Custom Fields',
      steps: [
        {
          title: 'Test',
          schema: {
            properties: {
              name: {
                type: 'string',
                'ui:field': 'Mock',
              },
            },
          },
        },
      ],
    };

    const { getByText } = await renderInTestApp(
      <Stepper
        manifest={manifest}
        extensions={[{ name: 'Mock', component: MockComponent }]}
        onComplete={jest.fn()}
      />,
    );

    expect(getByText('im a custom field extension')).toBeInTheDocument();
  });

  it('should transform default error message', async () => {
    const manifest: TemplateParameterSchema = {
      steps: [
        {
          title: 'Step 1',
          schema: {
            properties: {
              postcode: {
                type: 'string',
                pattern: '[A-Z][0-9][A-Z] [0-9][A-Z][0-9]',
              },
            },
          },
        },
      ],
      title: 'transformErrors Form Test',
    };

    const transformErrors = (errors: RJSFValidationError[]) => {
      return errors.map(err =>
        err.property === '.postcode'
          ? { ...err, message: 'invalid postcode' }
          : err,
      );
    };

    const { getByText, getByRole } = await renderInTestApp(
      <Stepper
        manifest={manifest}
        extensions={[]}
        onComplete={jest.fn()}
        transformErrors={transformErrors}
      />,
    );

    await fireEvent.change(getByRole('textbox', { name: 'postcode' }), {
      target: { value: 'invalid' },
    });

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Review' }));
    });

    expect(getByText('invalid postcode')).toBeInTheDocument();
  });

  it('should initialize formState with undefined form values', async () => {
    const manifest: TemplateParameterSchema = {
      steps: [
        {
          title: 'Step 1',
          schema: {
            properties: {
              firstName: {
                type: 'string',
              },
            },
          },
        },
      ],
      title: 'initialize formData',
    };

    const onComplete = jest.fn(async (values: Record<string, JsonValue>) => {
      expect(values).toHaveProperty('firstName');
    });

    const { getByRole } = await renderInTestApp(
      <Stepper manifest={manifest} extensions={[]} onComplete={onComplete} />,
    );

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Review' }));
    });

    expect(getByRole('button', { name: 'Create' })).toBeInTheDocument();

    await act(async () => {
      await fireEvent.click(getByRole('button', { name: 'Create' }));
    });

    // flush promises
    return new Promise(process.nextTick);
  });
});
