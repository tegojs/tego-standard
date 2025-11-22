import {
  Context,
  Inject,
  InjectLog,
  Logger,
  MultipleRelationRepository,
  Next,
  Op,
  Repository,
  utils,
} from '@tego/server';

import type { WorkflowModel } from '../types';

export async function create(context: Context, next) {
  const { db } = context;
  const repository = utils.getRepositoryFromParams(context) as MultipleRelationRepository;
  const { whitelist, blacklist, updateAssociationValues, values, associatedIndex: workflowId } = context.action.params;

  context.body = await db.sequelize.transaction(async (transaction) => {
    const workflow = (await repository.getSourceModel(transaction)) as WorkflowModel;
    if (workflow.executed) {
      context.throw(400, 'Node could not be created in executed workflow');
    }

    const instance = await repository.create({
      values,
      whitelist,
      blacklist,
      updateAssociationValues,
      context,
      transaction,
    });

    if (!instance.upstreamId) {
      const previousHead = await repository.findOne({
        filter: {
          id: {
            $ne: instance.id,
          },
          upstreamId: null,
        },
        transaction,
      });
      if (previousHead) {
        await previousHead.setUpstream(instance, { transaction });
        await instance.setDownstream(previousHead, { transaction });
        instance.set('downstream', previousHead);
      }
      return instance;
    }

    const upstream = await instance.getUpstream({ transaction });

    if (instance.branchIndex == null) {
      const downstream = await upstream.getDownstream({ transaction });

      if (downstream) {
        await downstream.setUpstream(instance, { transaction });
        await instance.setDownstream(downstream, { transaction });
        instance.set('downstream', downstream);
      }

      await upstream.update(
        {
          downstreamId: instance.id,
        },
        { transaction },
      );

      upstream.set('downstream', instance);
    } else {
      const [downstream] = await upstream.getBranches({
        where: {
          id: {
            [Op.ne]: instance.id,
          },
          branchIndex: instance.branchIndex,
        },
        transaction,
      });

      if (downstream) {
        await downstream.update(
          {
            upstreamId: instance.id,
            branchIndex: null,
          },
          { transaction },
        );
        await instance.setDownstream(downstream, { transaction });
        instance.set('downstream', downstream);
      }
    }

    instance.set('upstream', upstream);

    return instance;
  });

  await next();
}

function searchBranchNodes(nodes, from): any[] {
  const branchHeads = nodes.filter((item: any) => item.upstreamId === from.id && item.branchIndex != null);
  return branchHeads.reduce(
    (flatten: any[], head) => flatten.concat(searchBranchDownstreams(nodes, head)),
    [],
  ) as any[];
}

function searchBranchDownstreams(nodes, from) {
  let result = [];
  for (let search = from; search; search = search.downstream) {
    result = [...result, search, ...searchBranchNodes(nodes, search)];
  }
  return result;
}

export async function destroy(context: Context, next) {
  const { db } = context;
  const repository = utils.getRepositoryFromParams(context) as Repository;
  const { filterByTk } = context.action.params;

  const fields = ['id', 'upstreamId', 'downstreamId', 'branchIndex'];
  const instance = await repository.findOne({
    filterByTk,
    fields: [...fields, 'workflowId'],
    appends: ['upstream', 'downstream', 'workflow'],
  });
  if (instance.workflow.executed) {
    context.throw(400, 'Nodes in executed workflow could not be deleted');
  }

  await db.sequelize.transaction(async (transaction) => {
    const { upstream, downstream } = instance.get();

    if (upstream && upstream.downstreamId === instance.id) {
      await upstream.update(
        {
          downstreamId: instance.downstreamId,
        },
        { transaction },
      );
    }

    if (downstream) {
      await downstream.update(
        {
          upstreamId: instance.upstreamId,
          branchIndex: instance.branchIndex,
        },
        { transaction },
      );
    }

    const nodes = await repository.find({
      filter: {
        workflowId: instance.workflowId,
      },
      fields,
      transaction,
    });
    const nodesMap = new Map();
    // make map
    nodes.forEach((item) => {
      nodesMap.set(item.id, item);
    });
    // overwrite
    // nodesMap.set(instance.id, instance);
    // make linked list
    nodes.forEach((item) => {
      if (item.upstreamId) {
        item.upstream = nodesMap.get(item.upstreamId);
      }
      if (item.downstreamId) {
        item.downstream = nodesMap.get(item.downstreamId);
      }
    });

    const branchNodes = searchBranchNodes(nodes, nodesMap.get(instance.id));

    await repository.destroy({
      filterByTk: [instance.id, ...branchNodes.map((item) => item.id)],
      transaction,
    });
  });

  context.body = instance;

  await next();
}

export async function update(context: Context, next) {
  const { db } = context;
  const repository = utils.getRepositoryFromParams(context);
  const { filterByTk, values, whitelist, blacklist, filter, updateAssociationValues } = context.action.params;
  context.body = await db.sequelize.transaction(async (transaction) => {
    // TODO(optimize): duplicated instance query
    const { workflow } = await repository.findOne({
      filterByTk,
      appends: ['workflow.executed'],
      transaction,
    });
    if (workflow.executed) {
      context.throw(400, 'Nodes in executed workflow could not be reconfigured');
    }

    return repository.update({
      filterByTk,
      values,
      whitelist,
      blacklist,
      filter,
      updateAssociationValues,
      context,
      transaction,
    });
  });

  await next();
}

export async function moveUp(context: Context, next) {
  const { db } = context;
  const repository = utils.getRepositoryFromParams(context) as Repository;
  const { filterByTk } = context.action.params;

  const fields = ['id', 'upstreamId', 'downstreamId', 'branchIndex', 'key'];
  const instance = await repository.findOne({
    filterByTk,
    fields: [...fields, 'workflowId'],
    appends: ['upstream', 'downstream', 'workflow'],
  });
  if (instance.workflow.executed) {
    context.throw(400, 'Nodes in executed workflow could not be deleted');
  }

  await db.sequelize.transaction(async (transaction) => {
    const { upstream, downstream } = instance.get();

    if (!upstream) {
      context.throw(400, 'First node could not be moved up');
    }

    const upUpStreamId = upstream.upstreamId;
    const upStreamId = upstream.id;

    if (upUpStreamId) {
      await repository.update({
        filterByTk: upUpStreamId,
        values: {
          downstreamId: instance.id,
        },
        transaction,
      });
    }

    await upstream.update(
      {
        downstreamId: instance.downstreamId,
        upstreamId: instance.id,
      },
      { transaction },
    );

    await instance.update(
      {
        downstreamId: instance.upstreamId,
        upstreamId: upUpStreamId,
      },
      {
        transaction,
      },
    );

    if (downstream) {
      await downstream.update(
        {
          upstreamId: upStreamId,
        },
        {
          transaction,
        },
      );
    }
  });

  context.body = instance;

  await next();
}

export async function moveDown(context: Context, next) {
  const { db } = context;
  const repository = utils.getRepositoryFromParams(context) as Repository;
  const { filterByTk } = context.action.params;

  const fields = ['id', 'upstreamId', 'downstreamId', 'branchIndex', 'key'];
  const instance = await repository.findOne({
    filterByTk,
    fields: [...fields, 'workflowId'],
    appends: ['upstream', 'downstream', 'workflow'],
  });
  if (instance.workflow.executed) {
    context.throw(400, 'Nodes in executed workflow could not be deleted');
  }

  await db.sequelize.transaction(async (transaction) => {
    const { upstream, downstream } = instance.get();

    const downDownstreamId = downstream.downstreamId;

    if (!downstream) {
      context.throw(400, 'Last node could not be moved up');
    }

    if (upstream) {
      await upstream.update(
        {
          downstreamId: instance.downstreamId,
        },
        {
          transaction,
        },
      );
    }

    await downstream.update(
      {
        upstreamId: instance.upstreamId,
        downstreamId: instance.id,
      },
      {
        transaction,
      },
    );

    await instance.update(
      {
        downstreamId: downDownstreamId,
        upstreamId: downstream.id,
      },
      {
        transaction,
      },
    );

    if (downDownstreamId) {
      await repository.update({
        filterByTk: downDownstreamId,
        values: {
          upstreamId: instance.id,
        },
        transaction,
      });
    }
  });

  context.body = instance;

  await next();
}

/**
 * 同步远程代码
 * 从远程地址获取代码并返回
 */
export async function syncRemoteCode(context: Context, next: Next) {
  const params = context.action.params.values || context.action.params || {};
  const { codeUrl, codeType, codeBranch = 'main', codePath, codeAuthType, codeAuthToken, codeAuthUsername } = params;

  if (!codeUrl || !codeType) {
    context.throw(400, 'codeUrl and codeType are required');
  }

  try {
    // 尝试获取云组件插件的 RemoteCodeFetcher 服务
    let remoteCodeFetcher;
    try {
      const cloudComponentPlugin = context.app.pm.get('@tego/module-cloud-component');
      if (cloudComponentPlugin) {
        remoteCodeFetcher = context.app.getService('RemoteCodeFetcher');
      }
    } catch (error) {
      // 如果云组件插件未安装，尝试直接获取服务
      try {
        remoteCodeFetcher = context.app.getService('RemoteCodeFetcher');
      } catch (e) {
        // 如果服务不存在，创建一个简单的实现
        context.logger.warn('RemoteCodeFetcher service not found, using fallback implementation');
      }
    }

    if (!remoteCodeFetcher) {
      // 如果无法获取服务，使用简单的 HTTP 请求实现
      const http = require('node:http');
      const https = require('node:https');
      const { URL } = require('node:url');

      const urlObj = new URL(codeUrl);
      const client = urlObj.protocol === 'https:' ? https : http;

      const code = await new Promise<string>((resolve, reject) => {
        const headers: Record<string, string> = {
          'User-Agent': 'TegoWorkflow/1.0',
        };

        if (codeAuthType === 'token' && codeAuthToken) {
          headers['Authorization'] = `Bearer ${codeAuthToken}`;
        } else if (codeAuthType === 'basic' && codeAuthUsername && codeAuthToken) {
          const credentials = Buffer.from(`${codeAuthUsername}:${codeAuthToken}`).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }

        const request = client.get(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            headers,
            timeout: 10000,
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`Failed to fetch: HTTP ${res.statusCode}`));
              return;
            }

            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });

            res.on('end', () => {
              resolve(data);
            });
          },
        );

        request.on('error', reject);
        request.on('timeout', () => {
          request.destroy();
          reject(new Error('Request timeout'));
        });
      });

      context.body = {
        code,
      };
    } else {
      // 使用 RemoteCodeFetcher 服务
      const code = await remoteCodeFetcher.fetchCode(
        codeUrl,
        codeType,
        codeBranch,
        codePath,
        codeAuthType,
        codeAuthToken,
        codeAuthUsername,
      );
      context.body = {
        code,
      };
    }

    await next();
  } catch (error) {
    context.logger.error('Failed to sync remote code', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      params,
    });

    context.throw(500, `Failed to fetch remote code: ${error instanceof Error ? error.message : String(error)}`);
  }
}
