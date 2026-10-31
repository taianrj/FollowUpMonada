'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

function databaseFixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(__dirname,'../lib/database/schema.sql'),'utf8'));
  const execute=async statements=>{
    sqlite.exec('BEGIN');
    try {
      const result=statements.map(({sql,params})=>({success:true,results:sqlite.prepare(sql).all(...params)}));
      sqlite.exec('COMMIT');return result;
    } catch(error) {sqlite.exec('ROLLBACK');throw error;}
  };
  return {sqlite,execute};
}

module.exports={databaseFixture};
