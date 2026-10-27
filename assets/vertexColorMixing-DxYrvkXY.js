import{t as e}from"./shaderStore-D-XQlhUT.js";var t=`bonesDeclaration`,n=`#if NUM_BONE_INFLUENCERS>0
#ifndef USE_VERTEX_PULLING
attribute matricesIndices : vec4f;attribute matricesWeights : vec4f;
#if NUM_BONE_INFLUENCERS>4
attribute matricesIndicesExtra : vec4f;attribute matricesWeightsExtra : vec4f;
#endif
#endif
#ifndef BAKED_VERTEX_ANIMATION_TEXTURE
#ifdef BONETEXTURE
var boneSampler : texture_2d<f32>;uniform boneTextureInfo : vec2f;
#else
uniform mBones : array<mat4x4f,BonesPerMesh>;
#endif
#ifdef BONES_VELOCITY_ENABLED
uniform mPreviousBones : array<mat4x4f,BonesPerMesh>;
#endif
#ifdef BONETEXTURE
fn readMatrixFromRawSampler(smp : texture_2d<f32>,index : f32)->mat4x4f
{let offset=i32(index)*4; 
let textureWidth=i32(uniforms.boneTextureInfo.x);let y=offset/textureWidth;let x=offset % textureWidth;let m0=textureLoad(smp,vec2<i32>(x+0,y),0);let m1=textureLoad(smp,vec2<i32>(x+1,y),0);let m2=textureLoad(smp,vec2<i32>(x+2,y),0);let m3=textureLoad(smp,vec2<i32>(x+3,y),0);return mat4x4f(m0,m1,m2,m3);}
#endif
#endif
#endif
`;e.IncludesShadersStoreWGSL[t]||(e.IncludesShadersStoreWGSL[t]=n);var r={name:t,shader:n},i=`clipPlaneVertexDeclaration`,a=`#ifdef CLIPPLANE
uniform vClipPlane: vec4<f32>;varying fClipDistance: f32;
#endif
#ifdef CLIPPLANE2
uniform vClipPlane2: vec4<f32>;varying fClipDistance2: f32;
#endif
#ifdef CLIPPLANE3
uniform vClipPlane3: vec4<f32>;varying fClipDistance3: f32;
#endif
#ifdef CLIPPLANE4
uniform vClipPlane4: vec4<f32>;varying fClipDistance4: f32;
#endif
#ifdef CLIPPLANE5
uniform vClipPlane5: vec4<f32>;varying fClipDistance5: f32;
#endif
#ifdef CLIPPLANE6
uniform vClipPlane6: vec4<f32>;varying fClipDistance6: f32;
#endif
`;e.IncludesShadersStoreWGSL[i]||(e.IncludesShadersStoreWGSL[i]=a);var o={name:i,shader:a},s=`fogVertexDeclaration`,c=`#ifdef FOG
varying vFogDistance: vec3f;
#endif
`;e.IncludesShadersStoreWGSL[s]||(e.IncludesShadersStoreWGSL[s]=c);var l={name:s,shader:c},u=`bonesVertex`,d=`#ifndef BAKED_VERTEX_ANIMATION_TEXTURE
#if NUM_BONE_INFLUENCERS>0
var influence : mat4x4<f32>;
#ifdef BONETEXTURE
influence=readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndices[0])*vertexInputs.matricesWeights[0];
#if NUM_BONE_INFLUENCERS>1
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndices[1])*vertexInputs.matricesWeights[1];
#endif 
#if NUM_BONE_INFLUENCERS>2
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndices[2])*vertexInputs.matricesWeights[2];
#endif 
#if NUM_BONE_INFLUENCERS>3
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndices[3])*vertexInputs.matricesWeights[3];
#endif 
#if NUM_BONE_INFLUENCERS>4
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndicesExtra[0])*vertexInputs.matricesWeightsExtra[0];
#endif 
#if NUM_BONE_INFLUENCERS>5
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndicesExtra[1])*vertexInputs.matricesWeightsExtra[1];
#endif 
#if NUM_BONE_INFLUENCERS>6
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndicesExtra[2])*vertexInputs.matricesWeightsExtra[2];
#endif 
#if NUM_BONE_INFLUENCERS>7
influence=influence+readMatrixFromRawSampler(boneSampler,vertexInputs.matricesIndicesExtra[3])*vertexInputs.matricesWeightsExtra[3];
#endif 
#else 
influence=uniforms.mBones[i32(vertexInputs.matricesIndices[0])]*vertexInputs.matricesWeights[0];
#if NUM_BONE_INFLUENCERS>1
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndices[1])]*vertexInputs.matricesWeights[1];
#endif 
#if NUM_BONE_INFLUENCERS>2
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndices[2])]*vertexInputs.matricesWeights[2];
#endif 
#if NUM_BONE_INFLUENCERS>3
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndices[3])]*vertexInputs.matricesWeights[3];
#endif 
#if NUM_BONE_INFLUENCERS>4
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndicesExtra[0])]*vertexInputs.matricesWeightsExtra[0];
#endif 
#if NUM_BONE_INFLUENCERS>5
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndicesExtra[1])]*vertexInputs.matricesWeightsExtra[1];
#endif 
#if NUM_BONE_INFLUENCERS>6
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndicesExtra[2])]*vertexInputs.matricesWeightsExtra[2];
#endif 
#if NUM_BONE_INFLUENCERS>7
influence=influence+uniforms.mBones[i32(vertexInputs.matricesIndicesExtra[3])]*vertexInputs.matricesWeightsExtra[3];
#endif 
#endif
finalWorld=finalWorld*influence;
#endif
#endif
`;e.IncludesShadersStoreWGSL[u]||(e.IncludesShadersStoreWGSL[u]=d);var f={name:u,shader:d},p=`clipPlaneVertex`,m=`#ifdef CLIPPLANE
vertexOutputs.fClipDistance=dot(worldPos,uniforms.vClipPlane);
#endif
#ifdef CLIPPLANE2
vertexOutputs.fClipDistance2=dot(worldPos,uniforms.vClipPlane2);
#endif
#ifdef CLIPPLANE3
vertexOutputs.fClipDistance3=dot(worldPos,uniforms.vClipPlane3);
#endif
#ifdef CLIPPLANE4
vertexOutputs.fClipDistance4=dot(worldPos,uniforms.vClipPlane4);
#endif
#ifdef CLIPPLANE5
vertexOutputs.fClipDistance5=dot(worldPos,uniforms.vClipPlane5);
#endif
#ifdef CLIPPLANE6
vertexOutputs.fClipDistance6=dot(worldPos,uniforms.vClipPlane6);
#endif
`;e.IncludesShadersStoreWGSL[p]||(e.IncludesShadersStoreWGSL[p]=m);var h={name:p,shader:m},g=`fogVertex`,_=`#ifdef FOG
#ifdef SCENE_UBO
vertexOutputs.vFogDistance=(scene.view*worldPos).xyz;
#else
vertexOutputs.vFogDistance=(uniforms.view*worldPos).xyz;
#endif
#endif
`;e.IncludesShadersStoreWGSL[g]||(e.IncludesShadersStoreWGSL[g]=_);var v={name:g,shader:_},y=`vertexColorMixing`,b=`#if defined(VERTEXCOLOR) || defined(INSTANCESCOLOR) && defined(INSTANCES)
vertexOutputs.vColor=vec4f(1.0);
#ifdef VERTEXCOLOR
#ifdef VERTEXALPHA
vertexOutputs.vColor*=colorUpdated;
#else
vertexOutputs.vColor=vec4f(vertexOutputs.vColor.rgb*colorUpdated.rgb,vertexOutputs.vColor.a);
#endif
#endif
#ifdef INSTANCESCOLOR
vertexOutputs.vColor*=vertexInputs.instanceColor;
#endif
#endif
`;e.IncludesShadersStoreWGSL[y]||(e.IncludesShadersStoreWGSL[y]=b);var x={name:y,shader:b};export{l as a,f as i,v as n,o,h as r,r as s,x as t};
//# sourceMappingURL=vertexColorMixing-DxYrvkXY.js.map