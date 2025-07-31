import { Context, MultipleRelationRepository, Op, Repository, utils } from '@tego/server';

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
