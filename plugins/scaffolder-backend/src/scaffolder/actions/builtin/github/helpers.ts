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

import { Config } from '@backstage/config';
import { assertError, InputError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  GithubCredentialsProvider,
  ScmIntegrationRegistry,
} from '@backstage/integration';
import { OctokitOptions } from '@octokit/core/dist-types/types';
import { Octokit } from 'octokit';
import { Logger } from 'winston';
import {
  enableBranchProtectionOnDefaultRepoBranch,
  initRepoAndPush,
} from '../helpers';
import { getRepoSourceDirectory, parseRepoUrl } from '../publish/util';

const DEFAULT_TIMEOUT_MS = 60_000;

export async function getOctokitOptions(options: {
  integrations: ScmIntegrationRegistry;
  credentialsProvider?: GithubCredentialsProvider;
  token?: string;
  repoUrl: string;
}): Promise<OctokitOptions> {
  const { integrations, credentialsProvider, repoUrl, token } = options;
  const { owner, repo, host } = parseRepoUrl(repoUrl, integrations);

  const requestOptions = {
    // set timeout to 60 seconds
    timeout: DEFAULT_TIMEOUT_MS,
  };

  if (!owner) {
    throw new InputError(`No owner provided for repo ${repoUrl}`);
  }

  const integrationConfig = integrations.github.byHost(host)?.config;

  if (!integrationConfig) {
    throw new InputError(`No integration for host ${host}`);
  }

  // short circuit the `githubCredentialsProvider` if there is a token provided by the caller already
  if (token) {
    return {
      auth: token,
      baseUrl: integrationConfig.apiBaseUrl,
      previews: ['nebula-preview'],
      request: requestOptions,
    };
  }

  const githubCredentialsProvider =
    credentialsProvider ??
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);

  // TODO(blam): Consider changing this API to take host and repo instead of repoUrl, as we end up parsing in this function
  // and then parsing in the `getCredentials` function too the other side
  const { token: credentialProviderToken } =
    await githubCredentialsProvider.getCredentials({
      url: `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}`,
    });

  if (!credentialProviderToken) {
    throw new InputError(
      `No token available for host: ${host}, with owner ${owner}, and repo ${repo}`,
    );
  }

  return {
    auth: credentialProviderToken,
    baseUrl: integrationConfig.apiBaseUrl,
    previews: ['nebula-preview'],
  };
}

export async function createGithubRepoWithCollaboratorsAndTopics(
  client: Octokit,
  repo: string,
  owner: string,
  repoVisibility: 'private' | 'internal' | 'public',
  description: string | undefined,
  homepage: string | undefined,
  deleteBranchOnMerge: boolean,
  allowMergeCommit: boolean,
  allowSquashMerge: boolean,
  allowRebaseMerge: boolean,
  allowAutoMerge: boolean,
  access: string | undefined,
  collaborators:
    | (
        | {
            user: string;
            access: 'pull' | 'push' | 'admin' | 'maintain' | 'triage';
          }
        | {
            team: string;
            access: 'pull' | 'push' | 'admin' | 'maintain' | 'triage';
          }
        | {
            /** @deprecated This field is deprecated in favor of team */
            username: string;
            access: 'pull' | 'push' | 'admin' | 'maintain' | 'triage';
          }
      )[]
    | undefined,
  topics: string[] | undefined,
  logger: Logger,
) {
  // eslint-disable-next-line testing-library/no-await-sync-query
  const user = await client.rest.users.getByUsername({
    username: owner,
  });

  const repoCreationPromise =
    user.data.type === 'Organization'
      ? client.rest.repos.createInOrg({
          name: repo,
          org: owner,
          private: repoVisibility === 'private',
          visibility: repoVisibility,
          description: description,
          delete_branch_on_merge: deleteBranchOnMerge,
          allow_merge_commit: allowMergeCommit,
          allow_squash_merge: allowSquashMerge,
          allow_rebase_merge: allowRebaseMerge,
          allow_auto_merge: allowAutoMerge,
          homepage: homepage,
        })
      : client.rest.repos.createForAuthenticatedUser({
          name: repo,
          private: repoVisibility === 'private',
          description: description,
          delete_branch_on_merge: deleteBranchOnMerge,
          allow_merge_commit: allowMergeCommit,
          allow_squash_merge: allowSquashMerge,
          allow_rebase_merge: allowRebaseMerge,
          allow_auto_merge: allowAutoMerge,
          homepage: homepage,
        });

  let newRepo;

  try {
    newRepo = (await repoCreationPromise).data;
  } catch (e) {
    assertError(e);
    if (e.message === 'Resource not accessible by integration') {
      logger.warn(
        `The GitHub app or token provided may not have the required permissions to create the ${user.data.type} repository ${owner}/${repo}.`,
      );
    }
    throw new Error(
      `Failed to create the ${user.data.type} repository ${owner}/${repo}, ${e.message}`,
    );
  }

  if (access?.startsWith(`${owner}/`)) {
    const [, team] = access.split('/');
    await client.rest.teams.addOrUpdateRepoPermissionsInOrg({
      org: owner,
      team_slug: team,
      owner,
      repo,
      permission: 'admin',
    });
    // No need to add access if it's the person who owns the personal account
  } else if (access && access !== owner) {
    await client.rest.repos.addCollaborator({
      owner,
      repo,
      username: access,
      permission: 'admin',
    });
  }

  if (collaborators) {
    for (const collaborator of collaborators) {
      try {
        if ('user' in collaborator) {
          await client.rest.repos.addCollaborator({
            owner,
            repo,
            username: collaborator.user,
            permission: collaborator.access,
          });
        } else if ('team' in collaborator) {
          await client.rest.teams.addOrUpdateRepoPermissionsInOrg({
            org: owner,
            team_slug: collaborator.team,
            owner,
            repo,
            permission: collaborator.access,
          });
        }
      } catch (e) {
        assertError(e);
        const name = extractCollaboratorName(collaborator);
        logger.warn(
          `Skipping ${collaborator.access} access for ${name}, ${e.message}`,
        );
      }
    }
  }

  if (topics) {
    try {
      await client.rest.repos.replaceAllTopics({
        owner,
        repo,
        names: topics.map(t => t.toLowerCase()),
      });
    } catch (e) {
      assertError(e);
      logger.warn(`Skipping topics ${topics.join(' ')}, ${e.message}`);
    }
  }

  return newRepo;
}

export async function initRepoPushAndProtect(
  remoteUrl: string,
  password: string,
  workspacePath: string,
  sourcePath: string | undefined,
  defaultBranch: string,
  protectDefaultBranch: boolean,
  protectEnforceAdmins: boolean,
  owner: string,
  client: Octokit,
  repo: string,
  requireCodeOwnerReviews: boolean,
  bypassPullRequestAllowances:
    | {
        users?: string[];
        teams?: string[];
        apps?: string[];
      }
    | undefined,
  requiredStatusCheckContexts: string[],
  requireBranchesToBeUpToDate: boolean,
  config: Config,
  logger: any,
  gitCommitMessage?: string,
  gitAuthorName?: string,
  gitAuthorEmail?: string,
) {
  const gitAuthorInfo = {
    name: gitAuthorName
      ? gitAuthorName
      : config.getOptionalString('scaffolder.defaultAuthor.name'),
    email: gitAuthorEmail
      ? gitAuthorEmail
      : config.getOptionalString('scaffolder.defaultAuthor.email'),
  };

  const commitMessage = gitCommitMessage
    ? gitCommitMessage
    : config.getOptionalString('scaffolder.defaultCommitMessage');

  await initRepoAndPush({
    dir: getRepoSourceDirectory(workspacePath, sourcePath),
    remoteUrl,
    defaultBranch,
    auth: {
      username: 'x-access-token',
      password,
    },
    logger,
    commitMessage,
    gitAuthorInfo,
  });

  if (protectDefaultBranch) {
    try {
      await enableBranchProtectionOnDefaultRepoBranch({
        owner,
        client,
        repoName: repo,
        logger,
        defaultBranch,
        bypassPullRequestAllowances,
        requireCodeOwnerReviews,
        requiredStatusCheckContexts,
        requireBranchesToBeUpToDate,
        enforceAdmins: protectEnforceAdmins,
      });
    } catch (e) {
      assertError(e);
      logger.warn(
        `Skipping: default branch protection on '${repo}', ${e.message}`,
      );
    }
  }
}

function extractCollaboratorName(
  collaborator: { user: string } | { team: string } | { username: string },
) {
  if ('username' in collaborator) return collaborator.username;
  if ('user' in collaborator) return collaborator.user;
  return collaborator.team;
}
