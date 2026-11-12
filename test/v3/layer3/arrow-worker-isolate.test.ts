import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

describe('Arrow source in a worker isolate', () => {
  it('does not close a main-thread Session when the worker env exits', () => {
    const workerCode = `
      const {parentPort,workerData}=require('node:worker_threads');
      const m=require('./index.js'),a=require('apache-arrow');
      (async()=>{const s=new m.Session(workerData.path);
        const b=new a.Table({x:a.vectorFromArray([1],new a.Int32())}).batches[0];
        const h=await m.registerArrowReader([b],{session:s});
        try{await s.queryAsync("SELECT x FROM arrowstream('"+h.name+"')",{format:'CSV'})}
        finally{await h.close();s.close();await m.drainPending()}
        parentPort.postMessage('ok');
      })().catch(e=>{parentPort.postMessage(e.message);process.exitCode=1});
    `
    const script = `
      const {Worker}=require('node:worker_threads'),m=require('./index.js');
      (async()=>{const s=new m.Session();
        try{const worker=new Worker(${JSON.stringify(workerCode)},{eval:true,workerData:{path:s.path}});
          const value=await new Promise((resolve,reject)=>{
            worker.once('message',resolve);worker.once('error',reject)
          });
          if(value!=='ok')throw Error(value);
          await new Promise((resolve,reject)=>worker.once('exit',code=>code===0?resolve():reject(Error('exit '+code))));
          const result=await s.queryAsync('SELECT 7',{format:'CSV'});
          if(result.text().trim()!=='7')throw Error('main Session was closed');
          console.log('concurrent isolate OK');
        }finally{s.close();await m.drainPending()}
      })().catch(e=>{console.error(e);process.exitCode=1});
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('concurrent isolate OK')
  })

  it('tears down reader references before another isolate opens a Session', () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      const m = require('./index.js');
      const worker = new Worker(\
        "const m=require('./index.js'),a=require('apache-arrow'),{parentPort}=require('node:worker_threads');"+
        "(async()=>{const s=new m.Session();const b=new a.Table({x:a.vectorFromArray([1],new a.Int32())}).batches[0];"+
        "const h=await m.registerArrowReader([b],{session:s});try{await s.queryAsync(\\\"SELECT x FROM arrowstream('\\\"+h.name+\\\"')\\\",{format:'CSV'})}"+
        "finally{await h.close();s.close();await m.drainPending()}parentPort.postMessage('ok')})().catch(e=>{parentPort.postMessage(e.message);process.exitCode=1})",
        {eval:true});
      worker.once('message', value => { if (value !== 'ok') throw Error(value); });
      worker.once('exit', async code => {
        if (code !== 0) throw Error('worker exited ' + code);
        const s = new m.Session();
        try { if (s.query('SELECT 7','CSV').trim() !== '7') throw Error('main query failed'); }
        finally { s.close(); }
        console.log('isolate OK');
      });
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 8_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toContain('isolate OK')
  })
})
