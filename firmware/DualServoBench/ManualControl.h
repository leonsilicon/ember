#pragma once
#include <stdint.h>
namespace Manual {
constexpr uint32_t leaseMs=500;
constexpr int minUs=500,maxUs=2500;
struct State {
  uint32_t token=0,sequence=0,lastPacket=0,lastTick=0;
  int wheel=0,pan=0,lift=0,wheelPower=20,servoSpeed=10;
  int position[2]={1500,1500};
  bool enabled[2]={false,false};
  bool linked=false;
  void stop(){wheel=pan=lift=0;linked=false;}
  void session(uint32_t key,uint32_t now){stop();token=key;sequence=0;lastPacket=lastTick=now;}
  bool accept(uint32_t key,uint32_t seq,int w,int p,int l,int wp,int sp,uint32_t now){
    if(!key||key!=token||seq<=sequence||w<0||w>4||p<-1||p>1||l<-1||l>1||wp<0||wp>100||sp<0||sp>100)return false;
    sequence=seq;wheel=w;pan=p;lift=l;wheelPower=wp;servoSpeed=sp;lastPacket=now;linked=true;return true;
  }
  void tick(uint32_t now){
    if(linked&&uint32_t(now-lastPacket)>=leaseMs)stop();
    const uint32_t elapsed=uint32_t(now-lastTick);
    if(elapsed<20)return;
    lastTick=now;
    const uint32_t dt=elapsed>50?50:elapsed;
    const int directions[2]={pan,lift};
    for(int i=0;i<2;++i){
      if(!linked||!directions[i]||!servoSpeed)continue;
      enabled[i]=true;
      if(servoSpeed==100)position[i]=directions[i]>0?maxUs:minUs;
      else {
        int step=int(servoSpeed*20*dt/1000);if(step<1)step=1;
        position[i]+=directions[i]*step;
        if(position[i]<minUs)position[i]=minUs;if(position[i]>maxUs)position[i]=maxUs;
      }
    }
  }
  void targets(int &left,int &right)const{
    left=right=0;if(!linked)return;
    if(wheel==1){left=wheelPower;right=-wheelPower;}
    if(wheel==2){left=-wheelPower;right=wheelPower;}
    if(wheel==3){left=-wheelPower;right=-wheelPower;}
    if(wheel==4){left=wheelPower;right=wheelPower;}
  }
};
inline int duty(int percent){return percent*255/100;}
}
